/**
 * Every deadline and size cap in the system, in one table.
 *
 * Separated from `lib/collector.ts` so that the HTTP transport and the individual collectors can read
 * a budget without importing the orchestrator that spends it. What the numbers are and why they differ
 * from each other is the substance here, so each is argued in place.
 */
export const BUDGET = {
  /** Per-source deadline. A source exceeding this is reported as `timeout`. */
  perSourceMs: 4_000,
  /**
   * The site collector alone probes twice in sequence, falling back to http when https fails, so one
   * per-source deadline cannot cover both legs. Held apart from `perSourceMs` so that widening the
   * chain does not silently widen every other source too.
   */
  siteMs: 5_000,
  /**
   * The port-43 fallback, which is given less than a normal source rather than more.
   *
   * It is the slowest transport in the system and the only one with no framing, so a stalled registry is
   * indistinguishable from a slow one until the deadline fires, and a suffix whose registry is down
   * should not cost the whole analysis its remaining budget. It runs only where RDAP produced no answer,
   * so it is never on the path of a domain that already has a registration record, and it shares its
   * wave with the site probe: kept under `siteMs`, it adds no wall-clock time to an analysis.
   */
  whoisMs: 3_000,
  /**
   * The metered reputation source, held below a normal source deadline.
   *
   * It is a commercial API on a monthly request budget rather than a protocol this model depends on,
   * so it is the source most worth abandoning early: nothing downstream needs it, and it shares its
   * wave with the longer site probe, so the whole of it is free wall-clock time.
   */
  checkmailMs: 2_500,
  /** The last wave, which reads what the others already fetched and so needs very little. */
  signupMs: 1_500,
  /**
   * Whole-analysis deadline. Anything still pending is reported as `timeout`.
   *
   * Sized above the worst-case sequence rather than to it. The waves run `perSourceMs`, then `siteMs`,
   * then `signupMs`, so a request that times out at every step still finishes well inside this. The
   * remainder is deliberate slack: `remaining()` shrinks every per-source deadline once the global one
   * starts to bind, so a budget sized exactly to the sequence would quietly shorten the individual
   * sources on any request the platform happened to schedule slowly.
   */
  globalMs: 15_000,
  /** Cap on a single response body we are willing to read. */
  maxBodyBytes: 256 * 1024,
  /**
   * Redirect hops we will follow. Enforced in `fetch.ts`, which follows chains itself rather than
   * delegating to the runtime's own limit of twenty.
   */
  maxRedirects: 5,
} as const;

/**
 * Splits a source's deadline between the queries it makes, never going below `floor`.
 *
 * The collectors that fan out into several lookups were each doing this arithmetic inline and had
 * drifted into three spellings of it. The floor matters: a collector handed the tail of an
 * already-exhausted global budget should make one honest attempt rather than several that cannot
 * finish.
 */
export function splitBudget(totalMs: number, parts: number, floorMs = 1_200): number {
  return Math.max(floorMs, Math.floor(totalMs / parts));
}

/** Community APIs are being used for free, so identify the client honestly. */
export const USER_AGENT = 'domain-legitimacy-scorer/1.0 (signup-risk analysis; contact via repository)';
