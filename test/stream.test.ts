import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyze } from '@/lib/analyze';
import { normaliseInput } from '@/lib/domain';
import { createLineParser, encodeLine, readNdjsonStream } from '@/lib/ndjson';
import type { AnalyzeStreamEvent } from '@/lib/api-types';
import type { SourceStatus } from '@/lib/facts';

/**
 * The progress stream, which exists to report an analysis while it is happening rather than after.
 *
 * Two properties matter and neither is obvious from reading the endpoint. The framing has to survive a
 * network splitting the body wherever it likes, and the events have to describe exactly the analysis
 * that is returned at the end: a progress view that can disagree with the finished result is worse than
 * no progress view, because a reader has no way to tell which of the two was lying.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Enough of every upstream to let all seven sources reach a status without touching the network. The
 * statuses themselves are not what is under test, so the answers are deliberately thin; what matters is
 * that each source settles rather than what it settled on.
 */
function stubNetwork() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('data.iana.org')) {
      // A `.com` service has to be present: without one RDAP reports the suffix unsupported, which is
      // the single condition that sends the analysis to port 43 over a real TCP socket.
      return json({ services: [[['com'], ['https://rdap.test.invalid/']]] });
    }
    if (url.includes('rdap.test.invalid')) {
      return json({ events: [{ eventAction: 'registration', eventDate: '2015-06-01T00:00:00Z' }] });
    }
    if (url.includes('dns.google') || url.includes('cloudflare-dns')) {
      return json({ Status: 0, Answer: [] });
    }

    return new Response('<html><head><title>Test</title></head><body>hello</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as unknown as typeof fetch;
}

function okInput(domain: string) {
  const input = normaliseInput(domain);
  if (input.kind !== 'ok') throw new Error(`${domain} did not normalise to an analysable input`);
  return input;
}

describe('ndjson framing', () => {
  it('reassembles lines split across chunk boundaries', () => {
    const events = [
      { type: 'source', source: 'dns', status: 'ok', elapsedMs: 12 },
      { type: 'source', source: 'rdap', status: 'timeout', elapsedMs: 4000 },
      { type: 'result', domain: 'example.com' },
    ];
    const wire = events.map(encodeLine).join('');

    // One byte at a time is the worst case a stream can present, and the one a naive split would fail.
    const parser = createLineParser<Record<string, unknown>>();
    const seen = [...wire].flatMap((character) => parser.push(character));

    expect(seen).toEqual(events);
    expect(parser.flush()).toEqual([]);
  });

  it('holds back a line whose remainder has not arrived', () => {
    const parser = createLineParser<{ n: number }>();

    expect(parser.push('{"n":1}\n{"n"')).toEqual([{ n: 1 }]);
    expect(parser.push(':2}\n')).toEqual([{ n: 2 }]);
  });

  it('yields several events from a single chunk', () => {
    const parser = createLineParser<{ n: number }>();
    const wire = [{ n: 1 }, { n: 2 }, { n: 3 }].map(encodeLine).join('');

    expect(parser.push(wire)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('discards a trailing fragment rather than throwing on a truncated stream', () => {
    const parser = createLineParser<{ n: number }>();

    expect(parser.push('{"n":1}\n{"trunc')).toEqual([{ n: 1 }]);
    expect(parser.flush()).toEqual([]);
  });
});

const encoder = new TextEncoder();

/** Serves `chunks` as separate reads, which is what a network does and a single `Response` does not. */
function chunked(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<Uint8Array>): Promise<T[]> {
  const seen: T[] = [];
  await readNdjsonStream<T>(stream, (event) => seen.push(event));
  return seen;
}

describe('reading a stream', () => {
  it('reports events in order as they arrive', async () => {
    const stream = chunked(encoder.encode('{"n":1}\n{"n":2}\n'), encoder.encode('{"n":3}\n'));

    expect(await collect(stream)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  /**
   * The reason the decoder is held across reads rather than created per chunk. Evidence strings carry
   * registrar and mark-holder names, so a multi-byte character landing on a packet boundary is not a
   * hypothetical; decoded per chunk it becomes replacement characters and the name is corrupted.
   */
  it('reassembles a multi-byte character split across two reads', async () => {
    const line = encoder.encode('{"name":"Bücher"}\n');
    // `ü` is two bytes and starts at offset 10, so this cuts it in half.
    const stream = chunked(line.slice(0, 11), line.slice(11));

    expect(await collect(stream)).toEqual([{ name: 'Bücher' }]);
  });

  it('drops a line the stream was cut in the middle of', async () => {
    const stream = chunked(encoder.encode('{"n":1}\n{"n":'));

    expect(await collect(stream)).toEqual([{ n: 1 }]);
  });
});

describe('per-source progress', () => {
  it('reports every source exactly once, and the same ones the result carries', async () => {
    stubNetwork();

    const seen: SourceStatus[] = [];
    const result = await analyze(okInput('example-business.com'), {
      onSource: (status) => seen.push(status),
    });

    const streamed = seen.map((status) => status.source).sort();
    const returned = result.facts.sources.map((status) => status.source).sort();

    expect(streamed).toEqual(returned);
    expect(new Set(streamed).size).toBe(streamed.length);
  });

  it('describes each source identically to the finished result', async () => {
    stubNetwork();

    const seen = new Map<string, SourceStatus>();
    const result = await analyze(okInput('example-business.com'), {
      onSource: (status) => seen.set(status.source, status),
    });

    // Elapsed time is measured by the collector, not at delivery, so the two are comparable in full.
    for (const status of result.facts.sources) {
      expect(seen.get(status.source)).toEqual(status);
    }
  });

  it('leaves the analysis unchanged when nothing is watching', async () => {
    stubNetwork();
    const watched = await analyze(okInput('example-business.com'), {
      onSource: () => {},
    });

    stubNetwork();
    const unwatched = await analyze(okInput('example-business.com'));

    // Order included: the sources array is built by `record`, which the callback must not reorder.
    expect(unwatched.facts.sources.map((s) => s.source)).toEqual(
      watched.facts.sources.map((s) => s.source),
    );
    expect(unwatched.score.legitimacy).toBe(watched.score.legitimacy);
  });

  it('does not let a failing consumer break the analysis', async () => {
    stubNetwork();

    const result = await analyze(okInput('example-business.com'), {
      onSource: () => {
        throw new Error('the client hung up');
      },
    });

    expect(result.facts.sources.length).toBeGreaterThan(0);
    expect(result.score.legitimacy).toBeGreaterThanOrEqual(0);
  });

  it('reports the second wave as it settles rather than all at once', async () => {
    // The wave is only recorded once `Promise.allSettled` resolves, so a naive hook reports its four
    // sources together at the end. Delaying one of them proves the events follow the collectors.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('data.iana.org')) {
        return json({ services: [[['com'], ['https://rdap.test.invalid/']]] });
      }
      if (url.includes('rdap.test.invalid')) {
        return json({ events: [] });
      }
      if (url.includes('dns.google') || url.includes('cloudflare-dns')) {
        // Mail is the second wave's only remaining network user once DNS has answered nothing.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return json({ Status: 0, Answer: [] });
      }
      return new Response('<html></html>', { status: 200 });
    }) as unknown as typeof fetch;

    const order: string[] = [];
    await analyze(okInput('example-business.com'), {
      onSource: (status) => order.push(status.source),
    });

    // Pricing reads a committed snapshot and whois is skipped, so both settle immediately; mail waits on
    // the delayed resolver. If events were emitted at the wave boundary all three would share a position.
    expect(order.indexOf('pricing')).toBeLessThan(order.indexOf('mail'));
    expect(order.indexOf('whois')).toBeLessThan(order.indexOf('mail'));
    expect(order[order.length - 1]).toBe('signup');
  });
});

describe('stream event shape', () => {
  it('round-trips a source event through the wire format', () => {
    const status: SourceStatus = {
      source: 'dns',
      status: 'timeout',
      reason: 'No response within 4000ms',
      elapsedMs: 4000,
    };

    const parser = createLineParser<AnalyzeStreamEvent>();
    const [event] = parser.push(encodeLine({ type: 'source', ...status }));

    expect(event).toEqual({ type: 'source', ...status });
  });
});
