import { describe, expect, it, vi } from 'vitest';
import { collectSite } from '@/lib/collect/site';
import { BUDGET } from '@/lib/budget';
import { probe } from '@/lib/fetch';
import { BlockedHostError } from '@/lib/errors';
import { page, redirectTo, restoreFetchBetweenTests, stubNetwork } from './helpers/network';

/**
 * Redirects are followed by `lib/fetch.ts` rather than by the runtime, for two reasons that these pin.
 *
 * `normaliseInput` rejects address literals and reserved names before anything is probed, but a redirect
 * target is a host chosen by the domain under analysis rather than by the caller. Handed to the platform,
 * the chain is capped at twenty hops and revalidated nowhere, so the boundary's decision held for exactly
 * one request and a domain answering `302 http://169.254.169.254/` had its target fetched, read, and
 * reported back with the status, size and title attached to the result.
 *
 * The same test applies to the URL a request starts at, which is the other half of the guard and is
 * covered at the bottom of this file. A hop is not the only way a domain gets to choose a host.
 */

restoreFetchBetweenTests();

describe('redirect chain', () => {
  it('follows an ordinary redirect and reports where it landed', async () => {
    stubNetwork((url) => (url === 'https://example.com/' ? redirectTo('https://elsewhere.com/') : page('Elsewhere')));

    const result = await probe('https://example.com/', { redirect: 'follow' });

    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe('https://elsewhere.com/');
  });

  it('resolves a relative location against the hop it came from', async () => {
    stubNetwork((url) => (url === 'https://example.com/' ? redirectTo('/welcome') : page('Welcome')));

    const result = await probe('https://example.com/', { redirect: 'follow' });

    expect(result.finalUrl).toBe('https://example.com/welcome');
  });

  /**
   * The case the guard exists for. A public name is the only thing the boundary lets through, so a
   * redirect is the one way to aim the probe at an address it already refused.
   */
  it.each([
    ['a loopback address', 'http://127.0.0.1:6379/'],
    ['a link-local address', 'http://169.254.169.254/latest/meta-data/'],
    ['a private address', 'http://10.0.0.1/'],
    ['an IPv6 literal', 'http://[::1]/'],
    ['localhost', 'http://localhost:8080/'],
    ['a reserved suffix', 'http://admin.internal/'],
    ['a non-http scheme', 'file:///etc/passwd'],
  ])('refuses to follow a redirect to %s', async (_case, target) => {
    const { urls } = stubNetwork((url) =>
      url === 'https://example.com/' ? redirectTo(target) : page('Should never be fetched'),
    );

    const result = await probe('https://example.com/', { redirect: 'follow' });

    expect(urls).toEqual(['https://example.com/']);
    expect(result.status).toBe(302);
    expect(result.finalUrl).toBe('https://example.com/');
    expect(result.body).toBe('');
  });

  it('stops at the hop limit rather than the runtime default of twenty', async () => {
    const { urls } = stubNetwork((url) => redirectTo(`${url}a`));

    await probe('https://example.com/', { redirect: 'follow' });

    // The first request plus one per permitted hop.
    expect(urls).toHaveLength(BUDGET.maxRedirects + 1);
  });

  /**
   * A signal per hop would let a chain multiply its collector's budget by the hop limit, which is the
   * quiet way a redirect turns into a timeout somewhere else in the analysis.
   */
  it('bounds the whole chain by one deadline rather than each hop separately', async () => {
    const signals = new Set<AbortSignal>();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) signals.add(signal);
      return redirectTo(`${String(input)}a`);
    }) as unknown as typeof fetch;

    await probe('https://example.com/', { redirect: 'follow', timeoutMs: 1_000 });

    expect(signals.size).toBe(1);
  });

  it('leaves a request that opted out of following alone', async () => {
    const { urls } = stubNetwork(() => redirectTo('https://elsewhere.com/'));

    const result = await probe('https://example.com/', { redirect: 'manual' });

    expect(urls).toEqual(['https://example.com/']);
    expect(result.status).toBe(302);
  });
});

/**
 * The initial URL gets the test every hop gets, because it is not always ours to choose. Most callers
 * pass a URL this process composed from an already-validated domain, but the BIMI collector fetches the
 * certificate a domain's own TXT record names, and a domain publishes its own DMARC policy too — so the
 * one caller that takes a URL from the analysed domain also controls the condition that reaches it.
 *
 * A refusal throws rather than returning something, because unlike a hop there is no response in hand
 * to report. `BlockedHostError` is its own type so `runCollector` can say the request was declined
 * rather than that the source broke.
 */
describe('refusing the initial URL', () => {
  it.each([
    ['a loopback address', 'http://127.0.0.1:6379/'],
    ['a link-local address', 'http://169.254.169.254/latest/meta-data/'],
    ['a private address', 'http://10.0.0.1/'],
    ['an IPv6 literal', 'http://[::1]/'],
    ['localhost', 'http://localhost:8080/'],
    ['a reserved suffix', 'http://admin.internal/'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a short-form address', 'http://127.1/'],
    ['an integer address', 'http://2130706433/'],
  ])('refuses to request %s without touching the network', async (_case, target) => {
    const { urls } = stubNetwork(() => page('Should never be fetched'));

    await expect(probe(target)).rejects.toBeInstanceOf(BlockedHostError);
    expect(urls).toEqual([]);
  });

  it('says the request was refused rather than that the host failed', async () => {
    stubNetwork(() => page('Should never be fetched'));

    await expect(probe('http://169.254.169.254/')).rejects.toThrow(
      /Refused to request 169\.254\.169\.254/,
    );
  });

  it('leaves an ordinary public URL alone', async () => {
    const { urls } = stubNetwork(() => page('Hello'));

    const result = await probe('https://example.com/');

    expect(result.status).toBe(200);
    expect(urls).toEqual(['https://example.com/']);
  });
});

describe('site collector on a refused redirect', () => {
  /**
   * Reported as reached but saying nothing, which is the honest reading: the domain answered and pointed
   * somewhere this probe will not go. Nothing about the target is read, so nothing about it can be
   * scored or shown, and the domain is not penalised for a fetch we declined to make.
   */
  it('reports the domain reachable without reading or naming the target', async () => {
    stubNetwork((url) =>
      url.startsWith('https://') ? redirectTo('http://169.254.169.254/latest/meta-data/') : page('Fallback'),
    );

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.reachable).toBe(true);
    expect(site.substantive).toBe(false);
    expect(site.finalUrl).toBe('https://example.com/');
    expect(site.redirectedOffDomain).toBe(false);
    expect(site.redirectTarget).toBeUndefined();
    expect(site.title).toBeUndefined();
  });

  it('still classifies a permitted off-domain redirect', async () => {
    stubNetwork((url) =>
      url === 'https://example.com/' ? redirectTo('https://sedo.com/parked') : page('Domain for sale'),
    );

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.redirectedOffDomain).toBe(true);
    expect(site.redirectTarget?.host).toBe('sedo.com');
    expect(site.parked).toBe(true);
  });
});
