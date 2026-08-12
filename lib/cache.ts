/**
 * Cache seam. The deployed default is `PassthroughCache`, which fetches every time, because the
 * current requirement is a fresh lookup per request. The interface exists so an Upstash or Vercel KV
 * implementation can be dropped in later without touching a collector.
 *
 * The only thing cached today is the IANA RDAP bootstrap, which is large, shared across every request
 * and changes at most daily. The suffix price list is not cached at all: it is a committed snapshot in
 * `lib/data/suffix-pricing.json`.
 */
export interface AnalysisCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

export class PassthroughCache implements AnalysisCache {
  async get<T>(): Promise<T | null> {
    return null;
  }

  async set(): Promise<void> {
    // Intentionally does nothing.
  }
}

/**
 * Process-local cache, used only for the lifetime of a single serverless invocation so that two
 * collectors needing the same bootstrap document do not fetch it twice. This is not a substitute for
 * a shared cache: instances are short-lived and not shared between requests.
 */
export class RequestScopedCache implements AnalysisCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}
