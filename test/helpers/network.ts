import { afterEach, vi } from 'vitest';

/**
 * Shared network stubbing for the collector suites.
 *
 * Every file that drives a collector has to replace `globalThis.fetch` and put it back afterwards, and
 * each one had grown its own copy of that plus a page builder. The copies were identical, which is the
 * problem: a fixture that means "a substantive page" should not be able to mean something slightly
 * different in two files that both assert on `substantive`.
 */

const originalFetch = globalThis.fetch;

/**
 * Restores the real `fetch` after each test in the calling file. Called at suite level for its side
 * effect, so a file that stubs the network cannot leak the stub into the next one.
 */
export function restoreFetchBetweenTests(): void {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
}

export type NetworkHandler = (
  url: string,
  signal: AbortSignal | null,
) => Response | Promise<Response>;

/** Replaces `fetch` with `handler`, returning the URLs it was asked for in order. */
export function stubNetwork(handler: NetworkHandler): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    return handler(url, (init?.signal as AbortSignal | undefined) ?? null);
  }) as unknown as typeof fetch;
  return { urls };
}

/** A page with a title and comfortably enough readable text to count as substantive. */
export const page = (title: string): Response =>
  new Response(`<html><head><title>${title}</title></head><body>${'x '.repeat(400)}</body></html>`, {
    status: 200,
  });

export const redirectTo = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

/** A host that accepts the connection and then says nothing, which is what a timeout actually is. */
export function hang(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
  });
}
