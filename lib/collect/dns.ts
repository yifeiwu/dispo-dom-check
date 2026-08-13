import { fetchJson } from '../fetch';
import type { DnsFacts } from '../facts';

/**
 * DNS over HTTPS.
 *
 * Two JSON resolvers are available and either will do; the second is a fallback rather than a second
 * opinion. Consensus across filtering resolvers was deliberately excluded from the model, so there is
 * no reason to query more than one working resolver, and doing so would only add latency.
 */

const RESOLVERS = [
  { name: 'primary DoH resolver', url: 'https://dns.google/resolve', headers: {} as Record<string, string> },
  {
    name: 'secondary DoH resolver',
    url: 'https://cloudflare-dns.com/dns-query',
    // Returns 400 without this header, which is easy to lose and hard to notice.
    headers: { accept: 'application/dns-json' },
  },
];

type DohAnswer = { name: string; type: number; TTL: number; data: string };
type DohResponse = {
  Status: number;
  /** Authenticated Data: the resolver validated DNSSEC, which saves a separate query. */
  AD?: boolean;
  Answer?: DohAnswer[];
  Authority?: DohAnswer[];
};

const RR = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16, NS: 2 } as const;

/**
 * The two response codes that carry an answer. `NXDOMAIN` is one of them: it states that the name does
 * not exist, which is a finding in its own right and the expected reply for a `www` or `mail` probe.
 *
 * Every other code means resolution failed. Reading one as an empty answer set is the difference
 * between "this domain publishes no records" and "we could not find out", and the first is a finding
 * the scoring model will act on. A domain whose nameservers `SERVFAIL` would otherwise be reported as
 * having no A, no NS and no MX, which reads as abandoned rather than unreachable.
 */
const ANSWERED_RCODES = new Set([0, 3]);

const RCODE_NAMES: Record<number, string> = {
  1: 'FORMERR',
  2: 'SERVFAIL',
  4: 'NOTIMP',
  5: 'REFUSED',
};

export type DnsQueryResult = { answers: DohAnswer[]; authenticated: boolean; resolver: string; status: number };

/**
 * Single query, trying each resolver in turn. Returns NXDOMAIN as an empty answer set, not an error;
 * throws when no resolver could answer, so the caller can tell silence from failure.
 */
export async function query(
  name: string,
  type: keyof typeof RR,
  timeoutMs: number,
): Promise<DnsQueryResult> {
  let lastError: unknown;

  for (const resolver of RESOLVERS) {
    try {
      const url = `${resolver.url}?name=${encodeURIComponent(name)}&type=${type}`;
      const response = await fetchJson<DohResponse>(url, {
        timeoutMs,
        headers: resolver.headers,
      });
      // Thrown rather than returned, so a failed lookup falls through to the fallback resolver on the
      // same path as a transport failure. A broken delegation and an unreachable resolver are the same
      // problem from here: this resolver has no answer, so ask the other one.
      if (!ANSWERED_RCODES.has(response.Status)) {
        throw new Error(
          `${resolver.name} could not resolve ${type} for ${name} ` +
            `(${RCODE_NAMES[response.Status] ?? `response code ${response.Status}`})`,
        );
      }
      const wanted = RR[type];
      return {
        answers: (response.Answer ?? []).filter((a) => a.type === wanted || a.type === RR.CNAME),
        authenticated: response.AD === true,
        resolver: resolver.name,
        status: response.Status,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('No DoH resolver answered');
}

function txtValues(answers: DohAnswer[]): string[] {
  // Long TXT records arrive as concatenated quoted strings, which must be joined before parsing.
  return answers
    .filter((a) => a.type === RR.TXT)
    .map((a) =>
      a.data
        .split(/"\s+"/)
        .map((part) => part.replace(/^"|"$/g, ''))
        .join(''),
    );
}

function cnameTargets(answers: DohAnswer[]): string[] {
  return answers
    .filter((answer) => answer.type === RR.CNAME)
    .map((answer) => answer.data.replace(/\.$/, '').toLowerCase())
    .filter(Boolean);
}

export async function collectDns(domain: string, timeoutMs: number): Promise<DnsFacts> {
  const per = Math.max(1200, Math.floor(timeoutMs / 2));

  // Why the apex lookups failed, kept so the source reports the cause rather than a generic message.
  // Only the apex matters here: a subdomain probe that fails is an absence, not a broken source.
  const apexFailures: string[] = [];
  const apex = (promise: Promise<DnsQueryResult>) =>
    promise.catch((error: unknown) => {
      apexFailures.push(error instanceof Error ? error.message : 'Unknown failure');
      return null;
    });

  const [a, aaaa, ns, mx, txt, www, mailHost] = await Promise.all([
    apex(query(domain, 'A', per)),
    apex(query(domain, 'AAAA', per)),
    apex(query(domain, 'NS', per)),
    apex(query(domain, 'MX', per)),
    apex(query(domain, 'TXT', per)),
    /*
     * One lookup for `www`, not an address query and a CNAME query.
     *
     * A resolver returns the CNAME chain alongside whatever it resolved to, and `query` keeps those
     * records for every type, so a `www` that is a CNAME is already visible in the answer here. The
     * separate CNAME query was measured against 4,659 stored transcripts and changed the answer for one
     * domain, where the chain ended in NODATA and the resolver returned the zone's SOA without the CNAME.
     * That is one record class worth two points, against a round trip on the critical path of every
     * analysis: this collector's first wave gates every mail collector behind it.
     */
    query(`www.${domain}`, 'A', per).catch(() => null),
    query(`mail.${domain}`, 'A', per).catch(() => null),
  ]);

  /*
   * There are deliberately no business-service probes here any more.
   *
   * Six names were queried in parallel on every analysis — `autodiscover`, `enterpriseenrollment`,
   * `enterpriseregistration` and three SRV records — to feed `footprint.business_services`. That credit
   * was withdrawn in 1.3.0 because pointing a CNAME or SRV record at a vendor requires no account with
   * that vendor, and the calendaring and SIP names were credited for pointing anywhere at all.
   *
   * Retiring the queries with it is the point, and is the same call made for `robots.txt` in
   * `lib/collect/site.ts`. Nothing else read the fact: the record-breadth curve dropped its business
   * class in the same revision, and no combination consults it. Six round trips per analysis for a
   * signal that could no longer move a verdict in either direction — and with the BIMI lookup, a third
   * of all DNS work, 21.7 queries per analysis down to 14.6 across 4,746 stored transcripts.
   */

  // If nothing answered at all the source is unavailable rather than empty, since reporting "no
  // records" would let a network failure look like a finding.
  if (!a && !aaaa && !ns && !mx && !txt) {
    throw new Error(apexFailures[0] ?? 'No DoH resolver answered');
  }

  return {
    a: (a?.answers ?? []).filter((r) => r.type === RR.A).map((r) => r.data),
    aaaa: (aaaa?.answers ?? []).filter((r) => r.type === RR.AAAA).map((r) => r.data),
    ns: (ns?.answers ?? [])
      .filter((r) => r.type === RR.NS)
      .map((r) => r.data.replace(/\.$/, '').toLowerCase()),
    mx: (mx?.answers ?? [])
      .filter((r) => r.type === RR.MX)
      .map((r) => {
        const [priority, host] = r.data.split(/\s+/);
        return { priority: Number(priority) || 0, host: (host ?? '').replace(/\.$/, '').toLowerCase() };
      })
      .filter((entry) => entry.host.length > 0)
      .sort((x, y) => x.priority - y.priority),
    txt: txtValues(txt?.answers ?? []),
    wwwExists: (www?.answers.length ?? 0) > 0,
    mailHostExists: (mailHost?.answers.length ?? 0) > 0,
    dnssecValidated: a?.authenticated ?? ns?.authenticated ?? false,
    resolver: a?.resolver ?? ns?.resolver ?? mx?.resolver ?? 'DoH resolver',
  };
}

/** Resolves a hostname to IPv4 addresses, used to corroborate the free-routing fingerprint. */
export async function resolveA(host: string, timeoutMs: number): Promise<string[]> {
  const result = await query(host, 'A', timeoutMs);
  return result.answers.filter((r) => r.type === RR.A).map((r) => r.data);
}

/**
 * The mail exchangers published at an arbitrary name, used by the wildcard probe.
 *
 * Sorted, because the caller's whole question is whether two different names answer with the *same*
 * set, and comparing unordered answers would turn a resolver's round-robin into a disagreement.
 */
export async function mxAt(name: string, timeoutMs: number): Promise<string[]> {
  const result = await query(name, 'MX', timeoutMs);
  return result.answers
    .filter((r) => r.type === RR.MX)
    .map((r) => (r.data.split(/\s+/)[1] ?? '').replace(/\.$/, '').toLowerCase())
    .filter(Boolean)
    .sort();
}

/** Fetches a single TXT record set, used for DMARC, DKIM selectors and report authorisation. */
export async function txtAt(name: string, timeoutMs: number): Promise<string[]> {
  const result = await query(name, 'TXT', timeoutMs);
  return txtValues(result.answers);
}

/**
 * Resolves one CNAME hop for TXT records. Hosted DKIM commonly delegates selectors this way, and a
 * strict one-hop bound prevents malformed chains from consuming the source deadline.
 */
export async function txtAtFollowingCname(
  name: string,
  timeoutMs: number,
): Promise<{ records: string[]; cnameTarget?: string }> {
  const result = await query(name, 'TXT', timeoutMs);
  const direct = txtValues(result.answers);
  const cnameTarget = cnameTargets(result.answers)[0];
  if (direct.length > 0 || !cnameTarget) return { records: direct, cnameTarget };

  const followed = await query(cnameTarget, 'TXT', timeoutMs);
  return { records: txtValues(followed.answers), cnameTarget };
}