import { describe, expect, it } from 'vitest';
import { SITE_PLATFORMS, detectPlatform, inRange } from '../lib/data/site-platforms';

/**
 * The platform table and its detector, tested against response fragments rather than through a fetch.
 *
 * The credit this feeds was removed once already for measuring the wrong thing, so the assertions worth
 * having are the ones about *what establishes a match* rather than about coverage. A table that grows a
 * platform is an ordinary change; a table that starts crediting a domain for linking to Shopify is the
 * regression that got the previous version deleted.
 */

const SHOPIFY_ADDRESS = '23.227.38.65';

describe('IPv4 range matching', () => {
  it('matches inside a range and rejects outside it', () => {
    expect(inRange('23.227.38.65', '23.227.38.0/24')).toBe(true);
    expect(inRange('23.227.39.65', '23.227.38.0/24')).toBe(false);
  });

  /** A /32 is how the anycast apex targets are pinned, so an off-by-one here would silently widen them. */
  it('treats a /32 as exactly one address', () => {
    expect(inRange('75.2.70.75', '75.2.70.75/32')).toBe(true);
    expect(inRange('75.2.70.76', '75.2.70.75/32')).toBe(false);
  });

  /*
   * The two prefixes where the obvious `1 << (32 - prefix)` implementation is wrong, because JavaScript's
   * shift operators work on signed 32-bit integers and produce a negative mask.
   */
  it('is correct at the prefix lengths where a signed shift would break', () => {
    expect(inRange('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(inRange('8.8.8.8', '0.0.0.0/1')).toBe(true);
    expect(inRange('200.0.0.1', '0.0.0.0/1')).toBe(false);
  });

  it('rejects malformed input rather than guessing', () => {
    expect(inRange('not-an-address', '23.227.38.0/24')).toBe(false);
    expect(inRange('23.227.38.999', '23.227.38.0/24')).toBe(false);
    expect(inRange('2001:db8::1', '23.227.38.0/24')).toBe(false);
  });
});

describe('platform detection', () => {
  it('reaches the addressed tier only when the domain resolves into the platform', () => {
    const served = detectPlatform({ 'x-shopid': '12345' }, '', ['203.0.113.10']);
    expect(served?.provider).toBe('Shopify');
    expect(served?.confirmation).toBe('served');

    const addressed = detectPlatform({ 'x-shopid': '12345' }, '', [SHOPIFY_ADDRESS]);
    expect(addressed?.confirmation).toBe('served_and_addressed');
  });

  /*
   * The distinction the previous table did not draw. A page can reference a platform's CDN without being
   * served by it, and that is the case the credit must not pay for on its own.
   */
  it('treats a body reference alone as the weaker tier', () => {
    const match = detectPlatform({}, '<img src="https://cdn.shopify.com/logo.png">', ['203.0.113.10']);
    expect(match?.provider).toBe('Shopify');
    expect(match?.confirmation).toBe('served');
  });

  it('matches header names case-insensitively, since stored and live headers differ in case', () => {
    expect(detectPlatform({ 'X-Wix-Request-Id': 'abc' }, '', [])?.provider).toBe('Wix');
  });

  it('matches a header value where the name alone is too common to mean anything', () => {
    expect(detectPlatform({ server: 'Pepyaka' }, '', [])?.provider).toBe('Wix');
    expect(detectPlatform({ server: 'nginx' }, '', [])).toBeNull();
  });

  it('says nothing when the response carries no platform evidence', () => {
    expect(detectPlatform({ server: 'nginx' }, '<html><body>Hello</body></html>', [SHOPIFY_ADDRESS])).toBeNull();
  });

  it('reports what matched, so the evidence never asks the reader to take it on faith', () => {
    expect(detectPlatform({ 'x-shopid': '1' }, '', [])?.matchedOn).toContain('x-shopid');
    expect(detectPlatform({}, 'cdn11.bigcommerce.com', [])?.matchedOn).toContain('bigcommerce');
  });

  /*
   * Ghost is in the table with `paidCustomDomain: false` and is the reason the flag exists. Ghost Pro is
   * a paid product but Ghost is open source, so its markers are equally consistent with somebody running
   * it on a rented box. Detecting it is fine; paying for it would be crediting a free thing.
   */
  it('marks a self-hostable platform as not implying payment', () => {
    const match = detectPlatform({ 'x-ghost-cache-status': 'HIT' }, '', []);
    expect(match?.provider).toBe('Ghost');
    expect(match?.paidCustomDomain).toBe(false);
  });
});

describe('the table itself', () => {
  it('gives every platform at least one way to be recognised', () => {
    for (const platform of SITE_PLATFORMS) {
      expect(
        platform.headers.length + platform.body.length,
        `${platform.provider} has no markers`,
      ).toBeGreaterThan(0);
    }
  });

  /*
   * A range is a claim that the platform answers from its own space. Where the platform fronts with a
   * general-purpose CDN the address identifies the CDN, and pinning it would credit every domain behind
   * that CDN, so an empty list is the correct entry rather than a missing one.
   */
  it('only publishes ranges that are well-formed', () => {
    for (const platform of SITE_PLATFORMS) {
      for (const cidr of platform.ranges) {
        expect(cidr, `${platform.provider}: ${cidr}`).toMatch(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/);
        const [network] = cidr.split('/');
        expect(inRange(network, cidr), `${platform.provider}: ${cidr} excludes its own network address`).toBe(true);
      }
    }
  });

  it('never claims a platform is both self-hostable and creditable', () => {
    for (const platform of SITE_PLATFORMS) {
      if (platform.paidCustomDomain) continue;
      // Nothing enforces this in the scorer beyond the signal reading the flag, so it is pinned here.
      expect(platform.ranges, `${platform.provider} is uncredited and needs no ranges`).toEqual([]);
    }
  });
});
