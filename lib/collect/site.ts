import { BUDGET } from '../budget';
import { probe, type ProbeResult } from '../fetch';
import { matchDisposableTitle } from '../data/disposable-fingerprints';
import { PARKING_BODY_FINGERPRINTS, PLACEHOLDER_PHRASES, matchParkingNameserver } from '../data/parking-ns';
import { classifyRedirectTarget } from '../data/redirect-targets';
import { detectPlatform } from '../data/site-platforms';
import type { DnsFacts, SiteFacts } from '../facts';

/**
 * Site existence, deliberately slim.
 *
 * The only question worth answering is whether this domain does anything other than receive mail. Deeper
 * content analysis was excluded as phishing-oriented, and several of the checks considered encoded a
 * geographic bias against legitimate small businesses.
 */

/** Below this much visible text a page is not saying anything, whatever its status code. */
const SUBSTANTIVE_TEXT_THRESHOLD = 500;

/**
 * Enough text that the page is self-evidently not a placeholder, whatever it links to.
 *
 * This is the escape hatch on the navigation requirement below, and it exists for script-rendered
 * sites, whose links are assembled by JavaScript the probe does not run and so are absent from the
 * HTML. Of the five legitimate pages in the holdout carrying real content and no anchor at all, four
 * are in that shape, at 18,000 to 262,000 characters. Nothing a parking service or a farm serves comes
 * close: the Hostinger and Spaceship placeholder pages run to about 925 and 2,700 characters, so the
 * bound is set an order of magnitude above the population it has to exclude rather than between two
 * neighbouring clusters.
 */
const SELF_EVIDENT_TEXT_THRESHOLD = 15_000;

/**
 * The https probe and its http fallback run in sequence, so they divide one budget rather than each
 * claiming it whole. Sizing them independently overran the collector's deadline, which abandoned the
 * fallback while it was still in flight — and the fallback is the leg that recovers the domain, having
 * answered for 59 of the 60 holdout domains it reached.
 *
 * The https share is capped rather than proportional because the useful part of that distribution ends:
 * responses arriving after two seconds are 3% of successes, and they cost the fallback time it needs.
 */
const HTTPS_LEG_MS = 2_000;

/** Not enough left for a connection to complete, so the attempt would only burn the remainder. */
const MIN_FALLBACK_MS = 500;

/**
 * Keeps the chain inside the deadline that is enforcing it, leaving room for scheduling overhead. Taken
 * as a share of a budget too small to spare it, so the chain cannot outlast its deadline at any size.
 */
const CHAIN_MARGIN_MS = 250;
const CHAIN_MARGIN_SHARE = 0.05;

export async function collectSite(
  domain: string,
  dns: DnsFacts | undefined,
  timeoutMs: number,
): Promise<SiteFacts> {
  // Parking is more reliably detected from delegation than from page content, and it needs no fetch.
  const parkingNs = matchParkingNameserver(dns?.ns);
  const nsParkingEvidence = parkingNs
    ? `Delegated to ${parkingNs.provider} parking nameservers`
    : undefined;

  /**
   * Nothing was served, so every content-derived field is unobserved rather than false. Delegation is
   * still readable without a fetch, which is why parking survives into this answer.
   *
   * Reached two ways — a zone with no address at all, and a probe chain that never got a response —
   * and they are the same finding, so they share one construction rather than two copies that have to
   * be kept identical by hand.
   */
  const unreachable = (): SiteFacts => ({
    reachable: false,
    redirectedOffDomain: false,
    substantive: false,
    parked: parkingNs !== undefined,
    parkingEvidence: nsParkingEvidence,
    titleMatchesDomain: false,
  });

  if (dns && dns.a.length === 0 && dns.aaaa.length === 0) return unreachable();

  const root = await fetchRoot(domain, timeoutMs);
  if (!root) return unreachable();

  const title = extractTitle(root.body);
  const text = visibleText(root.body);
  const label = domain.split('.')[0];

  const finalHost = hostOf(root.finalUrl);
  const redirectedOffDomain = Boolean(
    finalHost && finalHost !== domain && !finalHost.endsWith(`.${domain}`),
  );
  const redirectClassification =
    redirectedOffDomain && finalHost ? classifyRedirectTarget(finalHost) : undefined;
  const redirectTarget =
    redirectClassification && finalHost ? { host: finalHost, ...redirectClassification } : undefined;
  const redirectParking = redirectTarget?.class === 'parking';

  // A soft 404 has to be caught by status code, since a large custom error page is otherwise
  // indistinguishable from a real one by size alone.
  const okStatus = root.status >= 200 && root.status < 300;

  /*
   * A website rather than a page, which is a distinction the text threshold alone cannot draw.
   *
   * The credit this feeds is for a domain that does something other than receive mail, and a title plus
   * five hundred characters describes a farm's single landing page exactly as well as a small business's
   * homepage. Somewhere else to go on the same domain does not: an about page, a contact page, a product
   * list. Measured against the stored responses, 200 of the 467 abuse pages earning this credit had no
   * internal link whatsoever, against 5 of 72 legitimate ones.
   *
   * This tightens an existing credit rather than adding one, which matters because internal links are
   * markup the domain writes about itself and could mint by the hundred. Nothing here pays for having
   * them; the credit is simply withheld from a page that has none, and withholding is not a penalty —
   * such a domain scores neutral rather than negative.
   */
  const internalPaths = countInternalPaths(root.body, domain);
  const hasSomewhereToGo = internalPaths > 0 || text.length >= SELF_EVIDENT_TEXT_THRESHOLD;

  /*
   * Whether the response is a real page, which is a different question from whether this domain earns
   * credit for it, and keeping them apart matters more than it looks.
   *
   * `substantive` below is the credit, and it requires the page to be this domain's own. This one asks
   * only about the bytes, so it stays true for a page served from somewhere else. The placeholder table
   * is gated on this rather than on the credit, because gating it on the credit conflated two unrelated
   * reasons for withholding one: a page with nothing on it, and a page belonging to a third party.
   * `mycloaked.id` redirects to Cloaked's own homepage, which carries a "Coming soon" badge on a feature
   * tile, and reading that as this domain being parked is precisely the mistake `redirectedOffDomain`
   * exists to prevent — somebody else's copy is not evidence about this name.
   */
  const pageHasSubstance =
    okStatus && text.length >= SUBSTANTIVE_TEXT_THRESHOLD && Boolean(title) && hasSomewhereToGo;
  const substantive = pageHasSubstance && !redirectedOffDomain;

  /*
   * Two tables rather than one, and the page gets a say in which applies. `PARKING_BODY_FINGERPRINTS`
   * holds sentences no working site prints, so they stand whatever else is on the page.
   * `PLACEHOLDER_PHRASES` holds ones that might be ordinary copy, and a page carrying a title, real
   * readable text and somewhere else to go has already answered them — see the note on that table for
   * what this was costing.
   *
   * Both still read the raw HTML rather than `text`, which keeps every localised asset path matchable
   * and is now safe for the prose half too: a phrase dispositive enough to sit in the first table is
   * not one that turns up incidentally in a class name or a script.
   */
  const matches = (table: readonly string[]) =>
    table.find(
      (fingerprint) =>
        root.body.toLowerCase().includes(fingerprint) || title?.toLowerCase().includes(fingerprint),
    );
  const bodyParking =
    matches(PARKING_BODY_FINGERPRINTS) ?? (pageHasSubstance ? undefined : matches(PLACEHOLDER_PHRASES));

  /*
   * Read from the response already in hand and the addresses already resolved, so this adds no request.
   *
   * That is the whole reason it can exist at all. The credit this feeds was removed in 1.2.0 along with
   * the apex CNAME lookup that fed it, on the rule that a fingerprint table nobody reads is not worth a
   * round trip. Reinstating it as a lookup would run into the same rule; reinstating it as a read of
   * bytes already fetched does not.
   *
   * Only the domain's own response is examined. A redirect off the domain is somebody else's page, and
   * attributing their platform to this domain is exactly the error `redirectedOffDomain` exists to stop.
   *
   * A parked page is excluded for a sharper reason, found by measuring this against the stored
   * transcripts. Squarespace is a registrar as well as a site builder, and a domain registered through
   * it with no site attached is served Squarespace's parking page, from Squarespace's own address
   * space, carrying Squarespace's own `x-contextid` header. That satisfies every test the addressed
   * tier applies while being the exact opposite of what the tier is meant to establish — four abuse
   * domains in the holdout are in that state and one of them reached the tier. Where a platform is both
   * the registrar and the host, serving the domain proves nothing about a purchase; refusing to read a
   * parked page as evidence of a paid site is what closes it.
   */
  const parked = Boolean(parkingNs || bodyParking || redirectParking);
  const platform =
    redirectedOffDomain || parked
      ? undefined
      : (detectPlatform(Object.fromEntries(root.headers), root.body, dns?.a ?? []) ?? undefined);

  return {
    reachable: true,
    status: root.status,
    finalUrl: root.finalUrl,
    redirectedOffDomain,
    redirectTarget,
    title,
    contentLength: text.length,
    internalPaths,
    /*
     * Read off the title whether or not the page counts as substantive, and whether or not it belongs
     * to this domain. A service announcing itself in four words has said enough, and a redirect to the
     * provider's own homepage is the normal shape for a vanity domain the provider issues.
     */
    declaredDisposable: matchDisposableTitle(title),
    substantive,
    parked,
    // Delegation first, being the most reliable of the three, then the page, then where it went.
    parkingEvidence:
      nsParkingEvidence ??
      (bodyParking
        ? `Page content matches a parking or placeholder fingerprint`
        : redirectParking
          ? `Redirects to ${redirectTarget?.provider ?? redirectTarget?.host} parking`
          : undefined),
    titleMatchesDomain: Boolean(
      !redirectedOffDomain &&
        title &&
        label.length >= 3 &&
        title.toLowerCase().replace(/[^a-z0-9]/g, '').includes(label.replace(/[^a-z0-9]/g, '')),
    ),
    platform,
  };
}

/**
 * The root page, over https and then http, as one chain inside one deadline.
 *
 * Separated from the classification above it so that the budget arithmetic is readable on its own:
 * the two legs divide a single deadline rather than each claiming it whole, and the margin keeps the
 * chain inside the deadline that is enforcing it.
 *
 * A parallel `robots.txt` probe used to run alongside this to feed a +2 credit; the audit measured
 * that credit firing on more legitimate domains than abuse ones and it was removed, so the request
 * went with it. It cost no wall-clock time, being parallel, but it was a second connection to every
 * domain analysed for a fact nothing now reads.
 */
async function fetchRoot(domain: string, timeoutMs: number): Promise<ProbeResult | null> {
  const chainMs =
    timeoutMs - Math.min(CHAIN_MARGIN_MS, Math.floor(timeoutMs * CHAIN_MARGIN_SHARE));
  const startedAt = Date.now();
  const unspent = () => chainMs - (Date.now() - startedAt);

  // Proportional only when the budget is too small for the fixed share, which happens when the global
  // deadline is already nearly spent.
  const httpsMs = Math.min(HTTPS_LEG_MS, Math.floor(chainMs * 0.45));

  return probe(`https://${domain}/`, {
    timeoutMs: httpsMs,
    redirect: 'follow',
    maxBytes: BUDGET.maxBodyBytes,
  }).catch(() => {
    // Whatever the https leg did not spend, rather than a second fixed share that would not fit.
    const fallbackMs = unspent();
    if (fallbackMs < MIN_FALLBACK_MS) return null;
    return probe(`http://${domain}/`, { timeoutMs: fallbackMs, redirect: 'follow' }).catch(() => null);
  });
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return match?.[1].replace(/\s+/g, ' ').trim() || undefined;
}

/**
 * Distinct same-domain paths the page offers, from the anchors in bytes already fetched.
 *
 * Counting distinct paths rather than anchors is the point. A navigation bar repeated in a header and a
 * footer is one destination listed twice, and a parking page's grid of twenty sponsored links is twenty
 * anchors to somebody else's host. What the credit wants to know is how many places this domain says it
 * has, so the set is keyed on the path.
 *
 * A trailing slash is normalised away and the root itself is discarded, because a page linking to its
 * own front page has not offered anywhere to go. Fragments, `mailto:`, `tel:` and `javascript:` are
 * skipped for the same reason: none of them is another page. A protocol-relative or absolute URL counts
 * only where its host is this domain or a subdomain of it, so linking out to a marketplace earns
 * nothing, and a malformed URL is ignored rather than throwing — this runs on whatever bytes a stranger
 * chose to return.
 */
function countInternalPaths(html: string, domain: string): number {
  const paths = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1].trim();
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(href)) continue;
    if (/^(?:https?:)?\/\//i.test(href)) {
      try {
        const url = new URL(href.startsWith('//') ? `https:${href}` : href);
        const host = url.hostname.toLowerCase();
        if (host === domain || host.endsWith(`.${domain}`)) paths.add(url.pathname.replace(/\/+$/, ''));
      } catch {
        // A href the page wrote is not required to parse.
      }
    } else if (!href.includes(':')) {
      paths.add(href.split(/[?#]/)[0].replace(/\/+$/, ''));
    }
  }
  paths.delete('');
  return paths.size;
}

/** Strips markup so that content length measures what a visitor would actually read. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
