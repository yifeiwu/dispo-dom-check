import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectSite } from '@/lib/collect/site';
import { BUDGET, runCollector } from '@/lib/collector';

/**
 * The site collector is the only one that makes two requests in sequence, and its two legs have to fit
 * inside the single deadline enforcing them. When they did not, the deadline abandoned the http fallback
 * mid-flight: the domain was reported unreachable, and on a recording run the attempt was never even
 * written down, because the request settled after the transcript had been taken.
 *
 * These pin the arithmetic rather than the constants, so the shares can be retuned without editing them.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** A host that accepts the connection and then says nothing, which is what a timeout actually is. */
function hang(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
  });
}

function stubNetwork(handler: (url: string, signal: AbortSignal | null) => Promise<Response>) {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    return handler(url, (init?.signal as AbortSignal | undefined) ?? null);
  }) as unknown as typeof fetch;
  return { urls };
}

const page = (title: string) =>
  new Response(`<html><head><title>${title}</title></head><body>${'x '.repeat(400)}</body></html>`, {
    status: 200,
  });

// Small enough to keep the suite fast; the shares are proportional, so the arithmetic is the same.
const BUDGET_MS = 1_200;

describe('analysis budget', () => {
  /**
   * The waves run in sequence, so the global deadline has to be larger than their sum. If it is not,
   * `remaining()` starts clawing time back off the individual sources, and every per-source deadline
   * silently becomes shorter than the number written next to it.
   */
  const worstCaseSequenceMs = BUDGET.perSourceMs + BUDGET.siteMs + BUDGET.signupMs;

  it('leaves the global deadline slack above the worst-case wave sequence', () => {
    expect(worstCaseSequenceMs).toBeLessThan(BUDGET.globalMs);
  });

  it('keeps enough slack that a slowly scheduled request does not shorten its sources', () => {
    expect(BUDGET.globalMs - worstCaseSequenceMs).toBeGreaterThanOrEqual(2_000);
  });

  it('gives the site collector room for two sequential legs, unlike a single-request source', () => {
    expect(BUDGET.siteMs).toBeGreaterThan(BUDGET.perSourceMs);
  });
});

describe('site collector budget', () => {
  it('still reaches the http fallback when the https leg burns its whole share', async () => {
    const { urls } = stubNetwork(async (url, signal) => {
      if (url.startsWith('https://example.com/robots.txt')) return new Response('', { status: 404 });
      if (url.startsWith('https://')) return hang(signal);
      return page('Example');
    });

    const result = await runCollector(
      'site',
      undefined,
      () => collectSite('example.com', undefined, BUDGET_MS),
      BUDGET_MS,
    );

    expect(result.status).toBe('ok');
    expect(result.data?.reachable).toBe(true);
    expect(urls).toContain('http://example.com/');
  });

  it('finishes inside its deadline when neither leg answers, rather than being abandoned', async () => {
    stubNetwork(async (_url, signal) => hang(signal));

    const startedAt = Date.now();
    const result = await runCollector(
      'site',
      undefined,
      () => collectSite('example.com', undefined, BUDGET_MS),
      BUDGET_MS,
    );

    // The collector returning `ok` is the point: it observed both failures and concluded unreachable,
    // instead of the deadline firing underneath it and discarding what the second leg was doing.
    expect(result.status).toBe('ok');
    expect(result.data?.reachable).toBe(false);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('leaves the fallback a smaller share than the leg that already ran', async () => {
    const deadlines: number[] = [];
    stubNetwork(async (url, signal) => {
      if (url.startsWith('https://example.com/robots.txt')) return new Response('', { status: 404 });
      // Timeouts are the only thing distinguishing the two legs' budgets from outside.
      const startedAt = Date.now();
      signal?.addEventListener('abort', () => deadlines.push(Date.now() - startedAt));
      return hang(signal);
    });

    await collectSite('example.com', undefined, BUDGET_MS);

    expect(deadlines).toHaveLength(2);
    const [httpsMs, fallbackMs] = deadlines;
    expect(httpsMs + fallbackMs).toBeLessThanOrEqual(BUDGET_MS);
  });
});
