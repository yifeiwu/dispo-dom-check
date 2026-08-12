import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDns, query, txtAtFollowingCname } from '@/lib/collect/dns';
import { classifyDkimProvider } from '@/lib/data/dns-services';
import { detectRegistrarDefault } from '@/lib/data/registrar-defaults';
import { classifyRedirectTarget } from '@/lib/data/redirect-targets';
import { registrarDefaultFarm } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

function doh(answers: { name: string; type: number; TTL: number; data: string }[]): Response {
  return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A resolver reply carrying a response code rather than an answer, e.g. 2 for SERVFAIL. */
function rcode(status: number): Response {
  return new Response(JSON.stringify({ Status: status }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('bounded CNAME-aware TXT resolution', () => {
  it('returns a directly published DKIM key without another query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      doh([{ name: 'selector._domainkey.example.com.', type: 16, TTL: 300, data: '"v=DKIM1; p=abc"' }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(txtAtFollowingCname('selector._domainkey.example.com', 1000)).resolves.toEqual({
      records: ['v=DKIM1; p=abc'],
      cnameTarget: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows exactly one delegated DKIM CNAME', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        doh([
          {
            name: 'selector1._domainkey.example.com.',
            type: 5,
            TTL: 300,
            data: 'selector1-example._domainkey.example.onmicrosoft.com.',
          },
        ]),
      )
      .mockResolvedValueOnce(
        doh([
          {
            name: 'selector1-example._domainkey.example.onmicrosoft.com.',
            type: 16,
            TTL: 300,
            data: '"v=DKIM1; p=def"',
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await txtAtFollowingCname('selector1._domainkey.example.com', 1000);
    expect(result.records).toEqual(['v=DKIM1; p=def']);
    expect(result.cnameTarget).toContain('onmicrosoft.com');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('failed resolution is distinguished from an empty answer', () => {
  it('falls through to the second resolver when the first cannot resolve the name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rcode(2))
      .mockResolvedValueOnce(doh([{ name: 'example.com.', type: 1, TTL: 300, data: '203.0.113.1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await query('example.com', 'A', 1000);
    expect(result.answers.map((answer) => answer.data)).toEqual(['203.0.113.1']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports the source as unavailable when every resolver returns SERVFAIL', async () => {
    // A fresh Response per call, since collectDns fans out and a body may only be read once.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(rcode(2))));

    // Silently succeeding with empty records here is the dangerous outcome: a broken delegation would
    // be scored as a domain that publishes no A, NS or MX at all.
    await expect(collectDns('example.com', 4000)).rejects.toThrow(/SERVFAIL/);
  });

  it('treats NXDOMAIN as a genuine answer of no records', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(rcode(3))));

    const facts = await collectDns('example.com', 4000);
    expect(facts.a).toEqual([]);
    expect(facts.ns).toEqual([]);
    expect(facts.wwwExists).toBe(false);
  });

  // Pins the reason `www` costs one query rather than two: the address answer carries the CNAME chain, so
  // a `www` that is only a CNAME is still detected. Restoring a separate CNAME lookup would pass this
  // test while paying for a round trip it does not need, so the call count is asserted too.
  it('detects a CNAME-only www from the address answer alone', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('www.example.com')
          ? doh([{ name: 'www.example.com.', type: 5, TTL: 300, data: 'example.com.' }])
          : doh([{ name: 'example.com.', type: 1, TTL: 300, data: '203.0.113.1' }]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const facts = await collectDns('example.com', 4000);
    expect(facts.wwwExists).toBe(true);

    const wwwQueries = fetchMock.mock.calls.filter(([url]) => String(url).includes('www.example.com'));
    expect(wwwQueries).toHaveLength(1);
  });
});

describe('bundled stateless classifiers', () => {
  it('identifies DKIM providers from a selector target', () => {
    expect(classifyDkimProvider('selector.example.onmicrosoft.com')).toBe('Microsoft 365');
  });

  it('classifies known redirects while leaving unknown targets unknown', () => {
    expect(classifyRedirectTarget('checkout.myshopify.com').class).toBe('hosted_destination');
    expect(classifyRedirectTarget('profile.linktr.ee').class).toBe('social_profile');
    expect(classifyRedirectTarget('unclassified.example').class).toBe('unknown');
  });

  it('requires registrar, nameserver and forwarding evidence to agree', () => {
    const profile = registrarDefaultFarm();
    expect(detectRegistrarDefault(profile.registration, profile.dns, profile.signup)?.provider).toBe(
      'Namecheap',
    );
    profile.registration = { ...profile.registration!, registrar: 'Another Registrar', registrarIanaId: '9999' };
    expect(detectRegistrarDefault(profile.registration, profile.dns, profile.signup)).toBeUndefined();
  });
});
