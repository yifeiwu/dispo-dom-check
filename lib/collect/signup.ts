import { matchMx } from '../data/mx-match';
import {
  TEMP_MAIL_MX,
  TEMP_MAIL_MX_ENDPOINTS,
  matchEndpoint,
  matchTempMailNs,
  matchTempMailSpf,
} from '../data/temp-mail-mx';
import { FORWARDER_MX } from '../data/forwarder-mx';
import {
  AMBIGUOUS_MAIL_MX,
  CONSUMER_MAIL_INFRASTRUCTURE_MX,
  FREE_MAIL_ROUTING_MX,
  PAID_MAIL_MX,
  ROUTING_CORROBORATION,
} from '../data/free-mail-routing';
import { mxAt, resolveA, resolveAddress } from './dns';
import type { DnsFacts, SignupFacts } from '../facts';

/**
 * Signup capability: the primary dimension.
 *
 * The question is whether this domain can mint unlimited deliverable addresses cheaply. Since SMTP port
 * 25 is unavailable from the deployment target, catch-all capability cannot be probed directly, so the
 * substitute is classifying the domain's mail configuration by provider class. That turns out to be
 * better than a probe anyway, because it generalises: an operator rotating throwaway front-end domains
 * keeps pointing them at the same mail exchangers.
 *
 * Classification is ordered by severity, since a domain can match more than one table and the most
 * consequential class should win.
 *
 * Two observations sit beside the classification rather than inside it, because both answer questions
 * the hostname tables are structurally unable to reach. The wildcard probe asks whether *every*
 * subdomain receives mail, and the in-zone lookup asks who is behind a mail exchanger that names only
 * the domain's own zone — including a CNAME onto a known provider, which the hostname tables cannot
 * see until the resolver's chain is kept. See each below.
 */
export async function collectSignup(
  domain: string,
  dns: DnsFacts | undefined,
  spfRecord: string | undefined,
  timeoutMs: number,
): Promise<SignupFacts> {
  const mxHosts = (dns?.mx ?? []).map((entry) => entry.host);

  if (mxHosts.length === 0) {
    // No inbound mail configured. This is explicitly *not* a penalty: an account farmer must receive
    // the verification message, so working mail is a precondition of the abuse rather than evidence of
    // it, and a domain that cannot receive mail fails at the verification step anyway.
    return { class: 'none', selfHosted: false };
  }

  /*
   * Started before classification rather than after it, and awaited at the end.
   *
   * The two are independent — the wildcard question is about the zone, not about which provider was
   * matched — so serialising them would add a full DNS round trip to the deadline of every domain that
   * has mail at all. Kicking it off here means it overlaps whatever the classifier does, including the
   * two lookups the classifier can itself make.
   */
  const wildcard = probeWildcardMx(domain, Math.min(timeoutMs, 1500));

  const classified = await classify(domain, mxHosts, dns, spfRecord, timeoutMs);
  return { ...classified, wildcardMx: await wildcard };
}

async function classify(
  domain: string,
  mxHosts: string[],
  dns: DnsFacts | undefined,
  spfRecord: string | undefined,
  timeoutMs: number,
): Promise<SignupFacts> {
  const fromHostname = classifyMxHosts(mxHosts, spfRecord, timeoutMs);
  if (fromHostname) return fromHostname;

  // Mail handled inside the domain's own namespace. Common for both a small business running its own
  // server and a temp-mail operator running one, so it scores neutrally unless the in-zone lookup,
  // an SPF include or a nameserver fingerprint names a provider.
  const selfHosted = mxHosts.some((host) => host === domain || host.endsWith(`.${domain}`));

  if (selfHosted) {
    const inZone = await identifyInZoneMx(mxHosts, spfRecord, timeoutMs);
    if (inZone) return inZone;
  }

  const spfMatch = matchTempMailSpf(spfRecord);
  if (spfMatch) {
    return {
      class: 'temp_mail',
      provider: spfMatch.provider,
      matchedHost: spfMatch.include,
      matchedVia: 'spf',
      selfHosted,
    };
  }

  const nsProvider = matchTempMailNs(dns?.ns);
  if (nsProvider) {
    const matchedHost = dns?.ns.find((host) => matchTempMailNs([host]) === nsProvider);
    return {
      class: 'temp_mail',
      provider: nsProvider,
      matchedHost,
      matchedVia: 'ns',
      selfHosted,
    };
  }

  return {
    class: selfHosted ? 'self_hosted' : 'unknown_host',
    matchedHost: mxHosts[0],
    selfHosted,
  };
}

function classifyMxHosts(
  mxHosts: string[],
  spfRecord: string | undefined,
  timeoutMs: number,
): Promise<SignupFacts> | SignupFacts | undefined {
  const tempMail = matchMx(mxHosts, TEMP_MAIL_MX);
  if (tempMail) {
    return {
      class: 'temp_mail',
      provider: tempMail.fingerprint.provider,
      matchedHost: tempMail.matchedHost,
      matchedVia: 'mx',
      selfHosted: false,
    };
  }

  const freeRouting = matchMx(mxHosts, FREE_MAIL_ROUTING_MX);
  if (freeRouting) {
    return (async () => ({
      class: 'free_routing' as const,
      provider: freeRouting.fingerprint.provider,
      matchedHost: freeRouting.matchedHost,
      matchedVia: 'mx' as const,
      corroboration: await corroborateRouting(freeRouting.matchedHost, spfRecord, timeoutMs),
      selfHosted: false,
    }))();
  }

  const forwarder = matchMx(mxHosts, FORWARDER_MX);
  if (forwarder) {
    return {
      class: 'forwarder',
      provider: forwarder.fingerprint.provider,
      matchedHost: forwarder.matchedHost,
      matchedVia: 'mx',
      selfHosted: false,
    };
  }

  // Checked before the paid table, because a large free provider's own infrastructure would otherwise
  // read as a paid business tenant on one of its vanity domains.
  const consumer = matchMx(mxHosts, CONSUMER_MAIL_INFRASTRUCTURE_MX);
  if (consumer) {
    return {
      class: 'consumer_infrastructure',
      provider: consumer.fingerprint.provider,
      matchedHost: consumer.matchedHost,
      matchedVia: 'mx',
      selfHosted: false,
    };
  }

  const paid = matchMx(mxHosts, PAID_MAIL_MX);
  if (paid) {
    return {
      class: 'paid_tenant',
      provider: paid.fingerprint.provider,
      matchedHost: paid.matchedHost,
      matchedVia: 'mx',
      selfHosted: false,
    };
  }

  const ambiguous = matchMx(mxHosts, AMBIGUOUS_MAIL_MX);
  if (ambiguous) {
    return {
      class: 'ambiguous_routing',
      provider: ambiguous.fingerprint.provider,
      matchedHost: ambiguous.matchedHost,
      matchedVia: 'mx',
      selfHosted: false,
    };
  }

  return undefined;
}

/**
 * Whether this zone answers with mail exchangers for names nobody created.
 *
 * This is the only observation in the model that watches the capability the primary dimension is
 * actually about, rather than inferring it from who runs the mailbox. A wildcard MX means every
 * subdomain receives mail, so one registration yields an unbounded supply of deliverable addresses at
 * no further cost — which is precisely what the throwaway-inbox services instruct their custom-domain
 * users to configure, in as many words, so that "any subdomain works automatically".
 *
 * It is a penalty and never a credit, which is what keeps it inside the `1.3.0` rule. That rule governs
 * credits, because a credit nothing can confirm is free for an operator to mint; a record that
 * incriminates the domain publishing it has no such problem.
 *
 * Two labels, not one. A single probe cannot tell a wildcard from a resolver or CDN that synthesises an
 * answer for whatever it is asked, so a wildcard is declared only where two independent names agree on
 * the same non-empty set.
 *
 * Three outcomes, matching the tri-state convention used elsewhere in these facts:
 *   `undefined`   neither probe could be answered, so nothing was learned and nothing may be scored
 *   `{hosts: []}` both probes answered and the zone does not wildcard, which is a finding
 *   `{hosts:[…]}` both probes agreed on a set, which is the capability
 */
async function probeWildcardMx(
  domain: string,
  timeoutMs: number,
): Promise<{ hosts: string[] } | undefined> {
  const [first, second] = await Promise.all([
    mxAt(`${probeLabel(domain, 1)}.${domain}`, timeoutMs).catch(() => null),
    mxAt(`${probeLabel(domain, 2)}.${domain}`, timeoutMs).catch(() => null),
  ]);

  // Silence from either probe is not a finding. Reading one unanswered lookup as "no wildcard" would
  // let a timeout clear a domain, and reading one answered lookup as a wildcard would let a synthesised
  // response condemn one.
  if (!first || !second) return undefined;

  if (first.length === 0 || second.length === 0) return { hosts: [] };
  if (first.join(',') !== second.join(',')) return { hosts: [] };

  return { hosts: first };
}

/**
 * The probe label, derived from the domain rather than drawn at random.
 *
 * Randomness is the obvious choice and it is the wrong one here, because it would break the calibration
 * harness rather than the request path. Recorded responses are keyed by request URL, so a label chosen
 * afresh on each run would never match what was captured: every replayed analysis would report two
 * misses and the lookups would throw, making the whole holdout unmeasurable. Deriving the label from
 * the domain gives the same name on every run for the same zone, which replays exactly.
 *
 * Nothing is lost against an adversary. The label only has to be a name the operator did not create,
 * and an operator who removes the wildcard to evade this has given up the capability it detects.
 */
function probeLabel(domain: string, ordinal: number): string {
  // FNV-1a, inline rather than imported: this needs to be stable across platforms and runtimes forever,
  // since a change to it silently invalidates every stored transcript.
  let hash = 0x811c9dc5;
  for (const character of `${ordinal}:${domain}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wc${ordinal}${hash.toString(36)}`;
}

/**
 * Who is behind a mail exchanger that names only the domain's own zone.
 *
 * `docs/CALIBRATION.md` records that the temp-mail hostname fingerprint matched none of the 123 rows
 * labelled `DISPOSABLE`, and the reason is structural rather than a short table. The throwaway services
 * that support custom domains tell the user to publish `mx.theirdomain.com` and point it at the
 * provider, so the mail exchanger names the customer's zone and reveals nothing. Every such domain is
 * invisible to a table of provider hostnames no matter how long that table grows.
 *
 * Two things behind that name are not invisible, and both come from the same A lookup:
 *
 * - a CNAME onto a hostname the provider owns, which the hostname tables already know
 * - an A record at an address the provider publishes in its setup instructions
 *
 * This runs only where the mail exchanger is in-zone, which bounds it to one extra lookup on the
 * population it was built for. It is deliberately not extended to every unrecognised exchanger, which
 * would spend a round trip on a large share of ordinary domains to ask a question their hostname has
 * already answered.
 *
 * On the resemblance to hosting reputation, which `docs/SOURCES.md` rejects: what is matched here is a
 * specific endpoint a provider publishes in its own setup instructions, not the reputation of an ASN or
 * a prefix. The precedent is the routing-prefix check below, which has done exactly this since `1.0.0`.
 * An endpoint that moves without notice stops matching and costs nothing, which is the safe direction
 * for a table to fail in.
 */
async function identifyInZoneMx(
  mxHosts: string[],
  spfRecord: string | undefined,
  timeoutMs: number,
): Promise<SignupFacts | undefined> {
  const host = mxHosts[0];
  try {
    const { addresses, cnameTargets } = await resolveAddress(host, Math.min(timeoutMs, 1500));
    const viaCname = classifyMxHosts(cnameTargets, spfRecord, timeoutMs);
    if (viaCname) {
      const classified = await viaCname;
      return { ...classified, matchedVia: 'cname', selfHosted: true };
    }

    if (TEMP_MAIL_MX_ENDPOINTS.length === 0) return undefined;
    for (const address of addresses) {
      const provider = matchEndpoint(address);
      if (provider) {
        return {
          class: 'temp_mail',
          provider,
          matchedHost: host,
          matchedAddress: address,
          matchedVia: 'address',
          selfHosted: true,
        };
      }
    }
  } catch {
    // The resolver did not answer. Silence is not evidence, so the domain keeps the neutral in-zone
    // classification it would have had if this lookup had never been attempted.
  }
  return undefined;
}

/**
 * Confirms a free-routing fingerprint the hostname tables matched, using whatever the provider
 * publishes to check against: an SPF include, a dedicated routing prefix, or both.
 *
 * Returning `undefined` rather than an empty array is the whole point of the signature. An empty array
 * is a finding — every available check ran and none of them agreed — whereas a provider with nothing to
 * check against and a check the network cut short are both silence, and the governing rule is that
 * silence never moves the score.
 */
async function corroborateRouting(
  matchedHost: string,
  spfRecord: string | undefined,
  timeoutMs: number,
): Promise<string[] | undefined> {
  const recipe = ROUTING_CORROBORATION.find((entry) => matchedHost.endsWith(entry.mxSuffix));
  if (!recipe) return undefined;

  const corroboration: string[] = [];

  if (spfRecord?.includes(recipe.spfInclude)) {
    corroboration.push(`SPF includes the provider's routing sender policy`);
  }

  if (recipe.targetPrefix) {
    try {
      const addresses = await resolveA(matchedHost, Math.min(timeoutMs, 1500));
      if (addresses.some((address) => address.startsWith(recipe.targetPrefix!))) {
        corroboration.push("Mail exchanger resolves inside the provider's dedicated routing prefix");
      }
    } catch {
      // The resolver did not answer, so this check has no result either way. Reporting that as a
      // disagreement would let a timeout discount a match that nothing actually contradicted.
      if (corroboration.length === 0) return undefined;
    }
  }

  return corroboration;
}
