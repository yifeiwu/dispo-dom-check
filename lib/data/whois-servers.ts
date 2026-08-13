import snapshot from './whois-servers.json';

/**
 * Port-43 servers for every root-zone suffix that publishes one, generated from IANA's root database by
 * `npm run refresh:whois`.
 *
 * The map once covered only the suffixes with no RDAP, on the reasoning that where a registry runs RDAP
 * that is the better source in every respect and a WHOIS entry beside it would answer a settled question
 * twice. RDAP is still preferred wherever it responds, and this map is read only after it has not: a
 * registry that stalls the connection instead of answering leaves the question open, and the old scope
 * meant the one transport that could still answer it was unreachable by construction. Measured against
 * the labelled holdout, that described 14% of domains, concentrated on registries that rate limit by
 * dropping the connection rather than returning a status.
 *
 * Of the 1438 suffixes in the root zone at the time of the snapshot, 872 publish a port-43 server and
 * appear here. The remaining 565 publish none, and where RDAP cannot answer for them either the domain
 * yields no age at all, which is the honest answer rather than a worse one.
 *
 * Discovery is committed rather than performed per request. The authoritative mapping is one more port-43
 * round trip to `whois.iana.org` before the real query, which would double the latency of the slowest
 * source in the system to learn something that changes on the order of years.
 */

const SERVERS = snapshot.servers as Record<string, string>;

/**
 * Finds the port-43 server for a suffix, preferring the longest matching entry.
 *
 * Unlike suffix pricing, inheriting from the parent suffix is correct here and not a guess. A registry
 * operates one WHOIS service for its whole namespace, so `co.nz` is answered by the `.nz` server by
 * definition — there is no second-level service to miss. The pricing collector refuses the same fallback
 * because a second-level namespace genuinely can cost a tenth of its parent, which is a fact about the
 * market rather than about the protocol.
 */
export function findWhoisServer(suffix: string): string | null {
  const labels = suffix.toLowerCase().split('.');
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');
    const server = SERVERS[candidate];
    if (server) return server;
  }
  return null;
}
