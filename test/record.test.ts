import { afterEach, describe, expect, it, vi } from 'vitest';
import { exists, fetchJson, fetchText, probe } from '@/lib/fetch';
import { TranscriptMissError, withHttpRecording, withHttpReplay } from '@/lib/record';
import { HttpError, RateLimitedError } from '@/lib/collector';

/**
 * The recorder exists so that an expensive collection run survives a change to the collectors. These
 * tests pin the two properties that makes true: a replayed run touches the network zero times, and what
 * it hands the parsers is indistinguishable from what they saw during collection, failures included.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: string) => Response): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls += 1;
    return handler(String(input));
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

describe('response recording', () => {
  it('replays a recorded body without touching the network', async () => {
    const network = stubFetch(() => new Response('{"Status":0}', { status: 200 }));

    const recorded = await withHttpRecording(() => fetchJson<{ Status: number }>('https://dns.example/resolve?name=a'));
    expect(recorded.value.Status).toBe(0);
    expect(network.calls()).toBe(1);

    const replayed = await withHttpReplay([recorded.transcript], () =>
      fetchJson<{ Status: number }>('https://dns.example/resolve?name=a'),
    );
    expect(replayed.value.Status).toBe(0);
    expect(replayed.misses).toEqual([]);
    expect(network.calls()).toBe(1);
  });

  it('stores the body unparsed, so a parser change can read a field the original run ignored', async () => {
    stubFetch(() => new Response('{"kept":1,"ignored":"still here"}', { status: 200 }));

    const { transcript } = await withHttpRecording(() => fetchText('https://api.example/thing'));

    expect(transcript.exchanges).toHaveLength(1);
    expect(transcript.exchanges[0].body).toBe('{"kept":1,"ignored":"still here"}');
  });

  it('replays a failure as the same error type, so a source keeps its status', async () => {
    stubFetch(() => new Response('nope', { status: 503 }));

    const recorded = await withHttpRecording(async () => {
      await expect(fetchText('https://api.example/down')).rejects.toBeInstanceOf(HttpError);
    });

    globalThis.fetch = (() => {
      throw new Error('replay must not reach the network');
    }) as unknown as typeof fetch;

    await withHttpReplay([recorded.transcript], async () => {
      await expect(fetchText('https://api.example/down')).rejects.toBeInstanceOf(HttpError);
    });
  });

  it('replays rate limiting rather than re-earning it', async () => {
    stubFetch(() => new Response('slow down', { status: 429 }));

    const recorded = await withHttpRecording(async () => {
      await expect(fetchText('https://api.example/limited')).rejects.toBeInstanceOf(RateLimitedError);
    });

    globalThis.fetch = (() => {
      throw new Error('replay must not reach the network');
    }) as unknown as typeof fetch;

    await withHttpReplay([recorded.transcript], async () => {
      await expect(fetchText('https://api.example/limited')).rejects.toBeInstanceOf(RateLimitedError);
    });
  });

  it('round-trips a site probe with its status, final URL and headers', async () => {
    stubFetch(
      () =>
        new Response('<title>Hello</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const recorded = await withHttpRecording(() => probe('https://site.example/'));
    const replayed = await withHttpReplay([recorded.transcript], () => probe('https://site.example/'));

    expect(replayed.value.status).toBe(recorded.value.status);
    expect(replayed.value.body).toBe('<title>Hello</title>');
    expect(replayed.value.headers.get('content-type')).toBe('text/html');
  });

  it('round-trips an absent resource as absence rather than as an error', async () => {
    stubFetch(() => {
      throw new Error('connection refused');
    });

    const recorded = await withHttpRecording(() => exists('https://site.example/robots.txt', 500));
    expect(recorded.value).toBeNull();

    const replayed = await withHttpReplay([recorded.transcript], () => exists('https://site.example/robots.txt', 500));
    expect(replayed.value).toBeNull();
  });

  it('keeps an existence check answerable when the recording has no entry for it', async () => {
    // `exists` never throws by contract, and a missing record must not be the one thing that makes it.
    const { transcript } = await withHttpRecording(async () => undefined);

    const replayed = await withHttpReplay([transcript], () => exists('https://site.example/robots.txt', 500));

    expect(replayed.value).toBeNull();
    expect(replayed.misses).toHaveLength(1);
  });

  it('reports a request the recording never saw instead of quietly fetching it', async () => {
    const { transcript } = await withHttpRecording(async () => undefined);

    const replayed = await withHttpReplay([transcript], async () => {
      await expect(fetchText('https://api.example/new-endpoint')).rejects.toBeInstanceOf(TranscriptMissError);
    });

    expect(replayed.misses).toHaveLength(1);
    expect(replayed.misses[0]).toContain('https://api.example/new-endpoint');
  });

  it('leaves the request path alone when nothing is recording', async () => {
    const network = stubFetch(() => new Response('live', { status: 200 }));

    expect(await fetchText('https://api.example/live')).toBe('live');
    expect(network.calls()).toBe(1);
  });
});
