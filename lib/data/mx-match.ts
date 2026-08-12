/**
 * Shared matching for the MX fingerprint tables.
 *
 * A fingerprint matches either an exact MX hostname or a hostname suffix. Suffix matching is what makes
 * the free-routing providers detectable at all, since they issue per-account and versioned mail
 * exchanger names under a stable parent, and matching exact hostnames would miss most of the population.
 */
export type MxFingerprint = {
  /** Display name shown as evidence in the UI. */
  provider: string;
  /**
   * Exact hostnames, or suffixes written with a leading dot. A bare suffix such as `improvmx.com`
   * also matches subdomains, because provider MX names are versioned (`mx1`, `mx2`).
   */
  patterns: string[];
  note?: string;
};

export function matchMx(
  mxHosts: readonly string[],
  table: readonly MxFingerprint[],
): { fingerprint: MxFingerprint; matchedHost: string } | null {
  for (const host of mxHosts) {
    const normalised = host.toLowerCase().replace(/\.$/, '');
    for (const fingerprint of table) {
      for (const pattern of fingerprint.patterns) {
        const p = pattern.toLowerCase();
        if (normalised === p || normalised.endsWith(p.startsWith('.') ? p : `.${p}`)) {
          return { fingerprint, matchedHost: normalised };
        }
      }
    }
  }
  return null;
}
