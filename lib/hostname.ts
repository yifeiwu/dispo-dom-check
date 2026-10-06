/**
 * One spelling of "the same host".
 *
 * DNS presentation format terminates a fully-qualified name with a dot and is case-insensitive, so the
 * same nameserver reaches us as `NS1.Example.COM.` from a DoH answer, `ns1.example.com` from an RDAP
 * record and `NS1.EXAMPLE.COM` from a port-43 one. Everything downstream — the parking table, the MX
 * provider tables, the comparison that decides whether a redirect left the domain — matches on the
 * lowercased, dotless form, so a collector that normalises differently silently stops matching.
 *
 * Returns `undefined` for anything that normalises to nothing, so callers can filter absent and empty
 * with the same test.
 */
export function normaliseHostname(value: string | undefined): string | undefined {
  return value?.trim().replace(/\.$/, '').toLowerCase() || undefined;
}

/**
 * Whether `host` is `suffix` itself or a name beneath it.
 *
 * This is the question every fingerprint table in `lib/data` asks, because providers issue versioned
 * and per-account names — `mx1.`, `mx2.`, `cust42.` — under a stable parent, so matching exact
 * hostnames would miss most of the population. Six tables each carried their own two-line copy of it
 * alongside their own spelling of the normalisation above, which is the drift this module was created
 * to prevent: a table that lowercases but forgets the trailing dot stops matching the day a resolver
 * starts returning the presentation form, and nothing fails loudly when it does.
 *
 * Both sides are normalised rather than only the input. The patterns in those tables are lowercase
 * literals today, so normalising them changes nothing now and stops a capitalised entry from being a
 * silent no-op later.
 *
 * A pattern written with a leading dot is not handled here, because it means something different —
 * suffix-only, excluding the bare name — and only `mx-match.ts` offers it. That stays where it is
 * documented.
 */
export function isAtOrUnder(host: string | undefined, suffix: string): boolean {
  const name = normaliseHostname(host);
  const parent = normaliseHostname(suffix);
  if (!name || !parent) return false;
  return name === parent || name.endsWith(`.${parent}`);
}

/**
 * Parses one MX record's rdata, which is a preference and an exchange separated by whitespace.
 *
 * A malformed preference is taken as 0 rather than dropping the record: the host is the part every
 * caller reads, and a resolver that returned something unparseable in the numeric half has still told
 * us where the mail goes.
 */
export function parseMxRdata(rdata: string): { priority: number; host: string } | undefined {
  const [priority, exchange] = rdata.split(/\s+/);
  const host = normaliseHostname(exchange);
  if (!host) return undefined;
  return { priority: Number(priority) || 0, host };
}
