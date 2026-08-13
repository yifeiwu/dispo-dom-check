import { BUDGET } from '../collector';
import { probe } from '../fetch';
import { PARKING_BODY_FINGERPRINTS, PARKING_NAMESERVERS } from '../data/parking-ns';
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
  const parkingNs = (dns?.ns ?? []).flatMap((ns) =>
    PARKING_NAMESERVERS.filter(({ pattern }) => ns.includes(pattern)),
  );

  if (dns && dns.a.length === 0 && dns.aaaa.length === 0) {
    return {
      reachable: false,
      redirectedOffDomain: false,
      substantive: false,
      parked: parkingNs.length > 0,
      parkingEvidence: parkingNs[0] ? `Delegated to ${parkingNs[0].provider} parking nameservers` : undefined,
      titleMatchesDomain: false,
    };
  }

  const chainMs =
    timeoutMs - Math.min(CHAIN_MARGIN_MS, Math.floor(timeoutMs * CHAIN_MARGIN_SHARE));
  const startedAt = Date.now();
  const unspent = () => chainMs - (Date.now() - startedAt);

  // Proportional only when the budget is too small for the fixed share, which happens when the global
  // deadline is already nearly spent.
  const httpsMs = Math.min(HTTPS_LEG_MS, Math.floor(chainMs * 0.45));

  /*
   * The root, and nothing else. A parallel `robots.txt` probe used to run alongside it to feed a +2
   * credit; the audit measured that credit firing on more legitimate domains than abuse ones and it was
   * removed, so the request went with it. It cost no wall-clock time, being parallel, but it was a second
   * connection to every domain analysed for a fact nothing now reads.
   */
  const root = await probe(`https://${domain}/`, {
    timeoutMs: httpsMs,
    redirect: 'follow',
    maxBytes: BUDGET.maxBodyBytes,
  }).catch(() => {
    // Whatever the https leg did not spend, rather than a second fixed share that would not fit.
    const fallbackMs = unspent();
    if (fallbackMs < MIN_FALLBACK_MS) return null;
    return probe(`http://${domain}/`, { timeoutMs: fallbackMs, redirect: 'follow' }).catch(() => null);
  });

  if (!root) {
    return {
      reachable: false,
      redirectedOffDomain: false,
      substantive: false,
      parked: parkingNs.length > 0,
      parkingEvidence: parkingNs[0] ? `Delegated to ${parkingNs[0].provider} parking nameservers` : undefined,
      titleMatchesDomain: false,
    };
  }

  const title = extractTitle(root.body);
  const text = visibleText(root.body);
  const label = domain.split('.')[0];

  const bodyParking = PARKING_BODY_FINGERPRINTS.find(
    (fingerprint) =>
      root.body.toLowerCase().includes(fingerprint) || title?.toLowerCase().includes(fingerprint),
  );

  let finalHost: string | undefined;
  try {
    finalHost = new URL(root.finalUrl).hostname;
  } catch {
    finalHost = undefined;
  }
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
  const parked = Boolean(parkingNs.length > 0 || bodyParking || redirectParking);
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
    substantive:
      !redirectedOffDomain && okStatus && text.length >= SUBSTANTIVE_TEXT_THRESHOLD && Boolean(title),
    parked,
    parkingEvidence: parkingNs[0]
      ? `Delegated to ${parkingNs[0].provider} parking nameservers`
      : bodyParking
        ? `Page content matches a parking or placeholder fingerprint`
        : redirectParking
          ? `Redirects to ${redirectTarget?.provider ?? redirectTarget?.host} parking`
          : undefined,
    titleMatchesDomain: Boolean(
      !redirectedOffDomain &&
        title &&
        label.length >= 3 &&
        title.toLowerCase().replace(/[^a-z0-9]/g, '').includes(label.replace(/[^a-z0-9]/g, '')),
    ),
    platform,
  };
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return match?.[1].replace(/\s+/g, ' ').trim() || undefined;
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
