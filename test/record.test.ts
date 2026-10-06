import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, fetchText, probe } from '@/lib/fetch';
import { TranscriptMissError, withHttpRecording, withHttpReplay } from '@/lib/record';
import { HttpError, RateLimitedError } from '@/lib/errors';
import { analyze } from '@/lib/analyze';
import { normaliseInput } from '@/lib/domain';
import { ageDays } from '@/lib/facts';
import { facts } from './fixtures';

/**
 * The recorder exists so that an expensive collection run survives a change to the collectors. These
 * tests pin the two properties that makes true: a replayed run touches the network zero times, and what
 * it hands the parsers is indistinguishable from what they saw during collection, failures included.
 *
 * The hosts are under `.example.com` rather than the shorter `.example` because `lib/fetch.ts` refuses
 * to request a reserved suffix, and RFC 2606 makes `.example` one. A fixture named for a host the
 * transport will not dial tests the guard rather than the recorder.
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

    const recorded = await withHttpRecording(() => fetchJson<{ Status: number }>('https://dns.example.com/resolve?name=a'));
    expect(recorded.value.Status).toBe(0);
    expect(network.calls()).toBe(1);

    const replayed = await withHttpReplay([recorded.transcript], () =>
      fetchJson<{ Status: number }>('https://dns.example.com/resolve?name=a'),
    );
    expect(replayed.value.Status).toBe(0);
    expect(replayed.misses).toEqual([]);
    expect(network.calls()).toBe(1);
  });

  it('stores the body unparsed, so a parser change can read a field the original run ignored', async () => {
    stubFetch(() => new Response('{"kept":1,"ignored":"still here"}', { status: 200 }));

    const { transcript } = await withHttpRecording(() => fetchText('https://api.example.com/thing'));

    expect(transcript.exchanges).toHaveLength(1);
    expect(transcript.exchanges[0].body).toBe('{"kept":1,"ignored":"still here"}');
  });

  it('replays a failure as the same error type, so a source keeps its status', async () => {
    stubFetch(() => new Response('nope', { status: 503 }));

    const recorded = await withHttpRecording(async () => {
      await expect(fetchText('https://api.example.com/down')).rejects.toBeInstanceOf(HttpError);
    });

    globalThis.fetch = (() => {
      throw new Error('replay must not reach the network');
    }) as unknown as typeof fetch;

    await withHttpReplay([recorded.transcript], async () => {
      await expect(fetchText('https://api.example.com/down')).rejects.toBeInstanceOf(HttpError);
    });
  });

  it('replays rate limiting rather than re-earning it', async () => {
    stubFetch(() => new Response('slow down', { status: 429 }));

    const recorded = await withHttpRecording(async () => {
      await expect(fetchText('https://api.example.com/limited')).rejects.toBeInstanceOf(RateLimitedError);
    });

    globalThis.fetch = (() => {
      throw new Error('replay must not reach the network');
    }) as unknown as typeof fetch;

    await withHttpReplay([recorded.transcript], async () => {
      await expect(fetchText('https://api.example.com/limited')).rejects.toBeInstanceOf(RateLimitedError);
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

    const recorded = await withHttpRecording(() => probe('https://site.example.com/'));
    const replayed = await withHttpReplay([recorded.transcript], () => probe('https://site.example.com/'));

    expect(replayed.value.status).toBe(recorded.value.status);
    expect(replayed.value.body).toBe('<title>Hello</title>');
    expect(replayed.value.headers.get('content-type')).toBe('text/html');
  });

  it('reports a request the recording never saw instead of quietly fetching it', async () => {
    const { transcript } = await withHttpRecording(async () => undefined);

    const replayed = await withHttpReplay([transcript], async () => {
      await expect(fetchText('https://api.example.com/new-endpoint')).rejects.toBeInstanceOf(TranscriptMissError);
    });

    expect(replayed.misses).toHaveLength(1);
    expect(replayed.misses[0]).toContain('https://api.example.com/new-endpoint');
  });

  it('leaves the request path alone when nothing is recording', async () => {
    const network = stubFetch(() => new Response('live', { status: 200 }));

    expect(await fetchText('https://api.example.com/live')).toBe('live');
    expect(network.calls()).toBe(1);
  });
});

/**
 * The other half of replay fidelity: the clock, which the responses cannot carry.
 *
 * Replaying a transcript reproduces every answer exactly and then dated them from the moment of the
 * replay, so a cache left alone for a few weeks quietly aged its own holdout. Age, term length and time
 * to expiry all derive from `meta.analysedAt`, which made the drift look like a scoring change: on a
 * seven-week-old cache it moved AUC by 0.004 and flipped `signup.ambiguous_routing` from KEEP to
 * REMOVE, neither of which had anything to do with the collectors a reparse exists to test.
 */
describe('analysis clock', () => {
  const asOk = (domain: string) => {
    const input = normaliseInput(domain);
    if (input.kind !== 'ok') throw new Error(`fixture domain was rejected as ${input.kind}`);
    return input;
  };

  it('reads the clock when no instant is supplied', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    const before = Date.now();

    const result = await analyze(asOk('example.com'));

    expect(Date.parse(result.facts.meta.analysedAt)).toBeGreaterThanOrEqual(before);
  });

  it('dates the analysis from the supplied instant, so a replay is not a different measurement', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    const captured = '2026-08-17T02:05:29.798Z';

    const result = await analyze(asOk('example.com'), { analysedAt: captured });

    expect(result.facts.meta.analysedAt).toBe(captured);
  });

  /** The property the audit actually depends on: the same transcript scores the same whenever it is read. */
  it('derives age from the supplied instant rather than from today', () => {
    const at = (analysedAt: string) =>
      facts({
        meta: { ...facts().meta, analysedAt },
        registration: {
          via: 'rdap',
          creation: '2026-08-01T00:00:00Z',
          statuses: [],
          nameservers: [],
        },
      });

    expect(ageDays(at('2026-08-17T00:00:00Z'))).toBe(16);
    expect(ageDays(at('2026-10-05T00:00:00Z'))).toBe(65);
  });
});
