import { describe, expect, it } from 'vitest';
import { fetchText } from '@/lib/fetch';
import { TimeoutError } from '@/lib/errors';
import { outsideDeadline, withDeadline } from '@/lib/deadline';
import { hang, restoreFetchBetweenTests, stubNetwork } from './helpers/network';

/**
 * The analysis-wide deadline, which used to be arithmetic rather than a stop.
 *
 * `remaining()` in the orchestrator shrinks the budget handed to each collector that has not started
 * yet, and that is all it can do: a request already in flight keeps the deadline it was given. A source
 * that began just inside the global budget therefore held its socket open behind a response that had
 * already been sent, which costs wall-clock time on the platform and a connection on an upstream being
 * used for free.
 *
 * These pin the composition rather than the fifteen-second number, so they stay fast and do not have to
 * be rewritten when the budget is retuned.
 */

restoreFetchBetweenTests();

describe('the analysis deadline', () => {
  it('ends a request that its own per-source deadline would have let run on', async () => {
    stubNetwork((_url, signal) => hang(signal));
    const analysis = new AbortController();

    const pending = withDeadline(analysis.signal, () =>
      // Far longer than the analysis will live, which is the case the per-source timeout cannot cover.
      fetchText('https://example.com/', { timeoutMs: 60_000 }),
    );

    analysis.abort();

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
  });

  it('gives up at once on a request begun after the deadline has passed', async () => {
    stubNetwork((_url, signal) => hang(signal));
    const analysis = new AbortController();
    analysis.abort();

    // `AbortSignal.any` reports an already-aborted input immediately, so this settles without waiting
    // out the sixty-second deadline the caller asked for.
    await expect(
      withDeadline(analysis.signal, () => fetchText('https://example.com/', { timeoutMs: 60_000 })),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('still honours a per-source deadline that expires first', async () => {
    stubNetwork((_url, signal) => hang(signal));
    const analysis = new AbortController();

    await expect(
      withDeadline(analysis.signal, () => fetchText('https://example.com/', { timeoutMs: 10 })),
    ).rejects.toBeInstanceOf(TimeoutError);

    expect(analysis.signal.aborted).toBe(false);
  });

  it('leaves a request made outside an analysis bounded only by its own deadline', async () => {
    stubNetwork(() => new Response('fine', { status: 200 }));

    await expect(fetchText('https://example.com/', { timeoutMs: 1_000 })).resolves.toBe('fine');
  });

  /**
   * The registry bootstrap is fetched under whichever analysis reached it first and deliberately keeps
   * running once that analysis has stopped waiting, so the next request finds it cached. Bounding it by
   * the request that triggered it would cancel it at the moment it became useful to anyone.
   */
  it('does not reach work that has detached itself from the analysis', async () => {
    const seen: (AbortSignal | null)[] = [];
    stubNetwork((_url, signal) => {
      seen.push(signal);
      return new Response('reference data', { status: 200 });
    });
    const analysis = new AbortController();

    const detached = await withDeadline(analysis.signal, async () =>
      outsideDeadline(() => fetchText('https://example.com/bootstrap', { timeoutMs: 1_000 })),
    );
    analysis.abort();

    expect(detached).toBe('reference data');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(false);
  });

  it('carries the deadline across the awaits a collector makes', async () => {
    stubNetwork(async (url, signal) => (url.endsWith('/second') ? hang(signal) : new Response('ok')));
    const analysis = new AbortController();

    const pending = withDeadline(analysis.signal, async () => {
      await fetchText('https://example.com/first', { timeoutMs: 60_000 });
      // A second request issued after an await, which is the shape every collector has. The context has
      // to survive the await for the deadline to reach it.
      return fetchText('https://example.com/second', { timeoutMs: 60_000 });
    });

    analysis.abort();

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
  });
});
