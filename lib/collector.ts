/**
 * The never-block contract.
 *
 * Every collector returns a `CollectorResult` and never throws into the request path. A source that
 * is slow, rate limited, broken or inapplicable produces a non-`ok` status carrying a human-readable
 * reason, and contributes no points in either direction. Missing data may only lower confidence.
 *
 * The corollary, which the whole scoring model depends on: penalise only on positive evidence.
 *
 * There is exactly one exception, added in `1.4.0` and bounded to a single point. `signup.checkmail`
 * credits 1 when the reputation source answers and finds nothing, so that the reader can see a
 * verdict was obtained rather than inferring it from a missing row. It is a credit for an absence,
 * which this rule otherwise forbids, and the reason it is tolerable is that one point cannot move a
 * band. See `docs/SCORING.md`.
 */

export type CollectorStatus =
  | 'ok'
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'unsupported'
  | 'skipped';

export type SourceId =
  | 'rdap'
  | 'whois'
  | 'dns'
  | 'mail'
  | 'signup'
  | 'pricing'
  | 'site'
  | 'checkmail';

export type CollectorResult<T> = {
  source: SourceId;
  status: CollectorStatus;
  /** Present only when `status` is `ok`. */
  data?: T;
  /**
   * Human-readable explanation, shown in the UI. Set by `runCollector` for every non-`ok` status, and
   * attachable by the caller to an `ok` one: a registry can answer in full and still publish nothing
   * usable, and "answered" alone would leave the reader to guess why the dimension is empty.
   */
  reason?: string;
  elapsedMs: number;
  sourceUrl?: string;
};

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

/** Community APIs are being used for free, so identify the client honestly. */
export const USER_AGENT = 'domain-legitimacy-scorer/1.0 (signup-risk analysis; contact via repository)';

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`exceeded ${ms}ms deadline`);
    this.name = 'TimeoutError';
  }
}

export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** A source that does not apply to this domain at all, e.g. a TLD with no RDAP service. */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs a collector under its deadline and converts every possible outcome into a `CollectorResult`.
 * This is the only place collector failure is interpreted, so the classification of a 429 versus a
 * 500 versus a timeout is consistent across sources.
 */
export async function runCollector<T>(
  source: SourceId,
  sourceUrl: string | undefined,
  fn: () => Promise<T>,
  timeoutMs: number = BUDGET.perSourceMs,
): Promise<CollectorResult<T>> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  try {
    const data = await withTimeout(fn(), timeoutMs);
    return { source, status: 'ok', data, elapsedMs: elapsed(), sourceUrl };
  } catch (error) {
    const base = { source, elapsedMs: elapsed(), sourceUrl };

    if (error instanceof TimeoutError) {
      return { ...base, status: 'timeout', reason: `No response within ${timeoutMs}ms` };
    }
    if (error instanceof RateLimitedError) {
      return { ...base, status: 'rate_limited', reason: error.message };
    }
    if (error instanceof UnsupportedError) {
      return { ...base, status: 'unsupported', reason: error.message };
    }
    if (error instanceof HttpError) {
      const status =
        error.statusCode === 429 || error.statusCode === 403 ? 'rate_limited' : 'unavailable';
      return { ...base, status, reason: error.message };
    }
    return {
      ...base,
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'Unknown failure',
    };
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    url: string,
  ) {
    super(`HTTP ${statusCode} from ${new URL(url).host}`);
    this.name = 'HttpError';
  }
}

export function isOk<T>(
  result: CollectorResult<T> | undefined,
): result is CollectorResult<T> & { data: T } {
  return result?.status === 'ok' && result.data !== undefined;
}
