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

import { BUDGET } from './budget';
import { HttpError, RateLimitedError, TimeoutError, UnsupportedError } from './errors';

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

export function isOk<T>(
  result: CollectorResult<T> | undefined,
): result is CollectorResult<T> & { data: T } {
  return result?.status === 'ok' && result.data !== undefined;
}
