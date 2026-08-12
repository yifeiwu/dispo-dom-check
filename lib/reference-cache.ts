import type { AnalysisCache } from './cache';
import { asSharedReference } from './record';

/**
 * A process-lifetime cache for *reference data* only: the registry bootstrap.
 *
 * This is deliberately not a cache of domain verdicts. Every domain is still analysed from scratch on
 * every request, which is the required behaviour. What is cached here is static reference data that is
 * identical for every domain and changes on the order of days.
 *
 * The suffix price feed used to live here too. It takes upwards of twelve seconds to answer, several
 * times the deadline any one source gets, so even cached it left the registration economics dimension
 * dead on the first request of every process. It is now a bundled snapshot in `lib/data` instead.
 */

type Entry = { value: unknown; expiresAt: number };

const store = new Map<string, Entry>();
/** In-flight fetches, so concurrent requests share one upstream call rather than starting several. */
const inflight = new Map<string, Promise<unknown>>();

export const referenceCache: AnalysisCache = {
  async get<T>(key: string): Promise<T | null> {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      store.delete(key);
      return null;
    }
    return entry.value as T;
  },

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
};

/**
 * Fetches reference data under a deadline, but lets a slow fetch keep running in the background so it
 * populates the cache for the next request.
 *
 * This is what makes a source slower than the request budget usable at all. The current request still
 * degrades honestly and reports a timeout rather than waiting, and the request after it gets real data.
 */
export async function withBackgroundRefresh<T>(
  key: string,
  ttlSeconds: number,
  deadlineMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = await referenceCache.get<T>(key);
  if (cached) return cached;

  let pending = inflight.get(key) as Promise<T> | undefined;

  if (!pending) {
    // Recorded apart from any one domain's transcript: this data is identical for every domain, and the
    // fetch happens under whichever analysis reached it first.
    pending = asSharedReference(fetcher)
      .then(async (value) => {
        await referenceCache.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
    // A background populate must never surface as an unhandled rejection when nobody is awaiting it.
    pending.catch(() => undefined);
  }

  return await Promise.race([
    pending,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Reference data did not arrive within ${deadlineMs}ms; it is still loading and will be available shortly`,
            ),
          ),
        deadlineMs,
      ),
    ),
  ]);
}
