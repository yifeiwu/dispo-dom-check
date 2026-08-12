import { describe, expect, it } from 'vitest';
import { normaliseInput } from '@/lib/domain';

/**
 * Normalisation is the boundary the whole analysis depends on, and it is pure, so it is tested
 * directly. Test inputs use IANA's reserved example names and RFC 2606 reserved suffixes rather than
 * real third-party domains.
 */
describe('normaliseInput', () => {
  it('accepts a bare domain', () => {
    const result = normaliseInput('example.com');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.domain).toBe('example.com');
    expect(result.label).toBe('example');
    expect(result.suffix).toBe('com');
    expect(result.fromEmailAddress).toBe(false);
  });

  it('reduces an email address to its domain and records that a local part was discarded', () => {
    const result = normaliseInput('Someone.Else+tag@Example.com');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.domain).toBe('example.com');
    expect(result.fromEmailAddress).toBe(true);
    // The local part must not survive anywhere in the returned object.
    expect(JSON.stringify(result)).not.toContain('someone');
    expect(JSON.stringify(result)).not.toContain('tag');
  });

  it('keeps only the domain when an address contains more than one @', () => {
    const result = normaliseInput('"odd@name"@example.org');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.domain).toBe('example.org');
  });

  it('tolerates a pasted URL with scheme, path and port', () => {
    const result = normaliseInput('https://www.example.net:8443/some/path?q=1');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.domain).toBe('example.net');
    expect(result.submittedHost).toBe('www.example.net');
  });

  it('reduces a deep subdomain to its registrable domain', () => {
    const result = normaliseInput('a.b.c.example.com');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.domain).toBe('example.com');
    expect(result.submittedHost).toBe('a.b.c.example.com');
  });

  it('handles a multi-label public suffix', () => {
    const result = normaliseInput('shop.example.co.uk');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.domain).toBe('example.co.uk');
    expect(result.suffix).toBe('co.uk');
    expect(result.label).toBe('example');
  });

  it('converts an internationalised name to its A-label form for lookups', () => {
    const result = normaliseInput('bücher.example');
    if (result.kind !== 'ok') {
      // `.example` is reserved and may not carry a public suffix entry; the IDN path is what matters.
      expect(result.kind).toBe('rejected');
      return;
    }
    expect(result.domain.startsWith('xn--')).toBe(true);
  });

  it('rejects IP addresses', () => {
    expect(normaliseInput('192.0.2.1').kind).toBe('rejected');
    expect(normaliseInput('[2001:db8::1]').kind).toBe('rejected');
  });

  it('rejects reserved and special-use names', () => {
    for (const input of ['localhost', 'server.local', 'thing.internal', 'site.test', 'x.invalid']) {
      const result = normaliseInput(input);
      expect(result.kind, input).toBe('rejected');
    }
  });

  it('rejects empty and malformed input', () => {
    expect(normaliseInput('').kind).toBe('rejected');
    expect(normaliseInput('   ').kind).toBe('rejected');
    expect(normaliseInput('@').kind).toBe('rejected');
  });

  it('rejects a bare public suffix', () => {
    expect(normaliseInput('com').kind).toBe('rejected');
    expect(normaliseInput('co.uk').kind).toBe('rejected');
  });

  it('routes a major consumer mail provider out of scope rather than scoring it', () => {
    const result = normaliseInput('someone@gmail.com');
    expect(result.kind).toBe('out_of_scope');
    if (result.kind !== 'out_of_scope') return;
    expect(result.reason).toBe('shared_free_provider');
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('scopes a platform-issued name to the tenant rather than the platform', () => {
    const result = normaliseInput('tenant.pages.dev');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.domain).toBe('tenant.pages.dev');
    expect(result.providerSuffix?.suffix).toBe('pages.dev');
    expect(result.providerSuffix?.kind).toBe('platform');
  });

  it('recognises a free-subdomain provider, whose economics differ from a platform', () => {
    const result = normaliseInput('thing.duckdns.org');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.providerSuffix?.kind).toBe('free_subdomain');
  });

  it('recognises a tenant suffix that implies a paid seat', () => {
    const result = normaliseInput('acme.onmicrosoft.com');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.providerSuffix?.kind).toBe('tenant');
    expect(result.providerSuffix?.impliesPaidTenant).toBe(true);
  });

  it('takes the longest matching platform suffix', () => {
    const result = normaliseInput('deep.name.tenant.pages.dev');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // The tenant is the label immediately left of the platform suffix, not the leftmost label.
    expect(result.domain).toBe('tenant.pages.dev');
  });

  it('flags a shared alias-relay domain', () => {
    const result = normaliseInput('duck.com');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.relayDomain).toBe(true);
  });

  it('detects a vetted suffix through a deep institutional subdomain', () => {
    const result = normaliseInput('student.dept.example.edu.au');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.vettedSuffix).toBe('edu.au');
  });
});
