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
