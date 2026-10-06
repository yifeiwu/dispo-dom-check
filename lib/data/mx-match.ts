import { isAtOrUnder, normaliseHostname } from '../hostname';

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
    const normalised = normaliseHostname(host);
    if (!normalised) continue;
    for (const fingerprint of table) {
      for (const pattern of fingerprint.patterns) {
        const p = pattern.toLowerCase();
        // A leading dot is suffix-only and excludes the bare name, which is the one shape
        // `isAtOrUnder` deliberately does not cover.
        const matched = p.startsWith('.') ? normalised.endsWith(p) : isAtOrUnder(normalised, p);
        if (matched) return { fingerprint, matchedHost: normalised };
      }
    }
  }
  return null;
}

/**
 * The exchangers a sender will actually try, which is the lowest `priority` value and every tie at it.
 *
 * Needed because matching the whole set is right for a penalty and wrong for a credit, and the two
 * cannot share one rule. A disposable exchanger anywhere in the set is evidence wherever it sits: the
 * operator put it there, and a lower-preference host does not undo that. A *credit* for paid mail
 * hosting is the opposite, because what makes an exchanger at Google or Microsoft worth points is not
 * that the records name them — pointing MX anywhere requires no account — but that mail arriving there
 * without a tenancy behind it is rejected, so an operator who needs to receive verification messages
 * cannot fake it. That argument only holds for the host delivery is attempted at.
 *
 * A backup exchanger therefore bought the credit outright while the real mailbox sat in front of it,
 * and 4 holdout domains were in exactly that shape — three of them abuse, one of them an in-zone
 * catch-all with `smtp.google.com` behind it. Mail never reaches the paid tenant on any of them.
 */
export function preferredMx(
  mx: readonly { priority: number; host: string }[],
): string[] {
  if (mx.length === 0) return [];
  const best = Math.min(...mx.map((entry) => entry.priority));
  return mx.filter((entry) => entry.priority === best).map((entry) => entry.host);
}
