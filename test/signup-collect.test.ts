import { describe, expect, it } from 'vitest';
import { collectSignup } from '@/lib/collect/signup';
import { matchDisposableVerification } from '@/lib/data/saas-verification-vendors';
import type { DnsFacts } from '@/lib/facts';
import { restoreFetchBetweenTests, stubNetwork } from './helpers/network';

/**
 * The custom-domain disguise, and the routes that see through it.
 *
 * A throwaway-inbox service selling custom domains tells the customer to publish a mail exchanger
 * inside their own zone, so every hostname table reads the domain as self-hosted. The collector has
 * to look at what that name *resolves to*: a CNAME onto a known provider, a published endpoint
 * address, an SPF include, or an ownership token. These shapes come from provider documentation, not
 * from the labelled holdout.
 */

restoreFetchBetweenTests();

const EMPTY_DNS: DnsFacts = {
  a: [],
  aaaa: [],
  ns: [],
  mx: [],
  txt: [],
  wwwExists: false,
  mailHostExists: false,
  dnssecValidated: false,
  resolver: 'test resolver',
};

function doh(answers: { name: string; type: number; TTL: number; data: string }[] = []): Response {
  return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Resolver replies for the wildcard probes and whatever else the test names. */
function zone(
  records: Record<string, { name: string; type: number; TTL: number; data: string }[]>,
): ReturnType<typeof stubNetwork> {
  return stubNetwork((url) => {
    const name = (new URL(url).searchParams.get('name') ?? '').replace(/\.$/, '').toLowerCase();
    return doh(records[name] ?? []);
  });
}

describe('in-zone mail exchanger that CNAMEs onto a known provider', () => {
  it('classifies a CNAME onto a throwaway-inbox hostname as temp_mail', async () => {
    zone({
      'mx.example.com': [
        { name: 'mx.example.com.', type: 5, TTL: 300, data: 'in.mailsac.com.' },
        { name: 'in.mailsac.com.', type: 1, TTL: 300, data: '203.0.113.9' },
      ],
    });

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mx.example.com' }] },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('temp_mail');
    expect(signup.provider).toBe('Mailsac');
    expect(signup.matchedVia).toBe('cname');
    expect(signup.matchedHost).toBe('in.mailsac.com');
    expect(signup.matchedAddress).toBeUndefined();
    expect(signup.selfHosted).toBe(true);
  });

  it('classifies a CNAME onto free routing as free_routing, and corroborates from SPF', async () => {
    zone({
      'mx.example.com': [
        { name: 'mx.example.com.', type: 5, TTL: 300, data: 'mx1.improvmx.com.' },
        { name: 'mx1.improvmx.com.', type: 1, TTL: 300, data: '203.0.113.8' },
      ],
    });

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mx.example.com' }] },
      'v=spf1 include:spf.improvmx.com ~all',
      2_000,
    );

    expect(signup.class).toBe('free_routing');
    expect(signup.provider).toBe('ImprovMX');
    expect(signup.matchedVia).toBe('cname');
    expect(signup.corroboration).toContain("SPF includes the provider's routing sender policy");
  });

  it('still reaches temp_mail from a published endpoint address when there is no CNAME', async () => {
    zone({
      'mx.example.com': [{ name: 'mx.example.com.', type: 1, TTL: 300, data: '46.62.148.222' }],
    });

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mx.example.com' }] },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('temp_mail');
    expect(signup.provider).toBe('TempMail.lol');
    expect(signup.matchedVia).toBe('address');
    expect(signup.matchedAddress).toBe('46.62.148.222');
  });
});

describe('zero-query fingerprints already in hand', () => {
  it('classifies from an SPF include a throwaway-inbox service publishes for custom domains', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mail.example.net' }] },
      'v=spf1 include:relays.mailsac.com ~all',
      2_000,
    );

    expect(signup.class).toBe('temp_mail');
    expect(signup.provider).toBe('Mailsac');
    expect(signup.matchedVia).toBe('spf');
    expect(signup.matchedHost).toBe('relays.mailsac.com');
  });

  it('reads a Mailsac ownership token out of the apex TXT set', () => {
    expect(matchDisposableVerification(['mailsac_0rlzMqMyDo2wDF6FuE0x54U5'])).toEqual(['Mailsac']);
  });

  it('does not let an SPF include override a hostname the exchanger itself named', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'aspmx.l.google.com' }] },
      'v=spf1 include:relays.mailsac.com include:_spf.google.com ~all',
      2_000,
    );

    expect(signup.class).toBe('paid_tenant');
    expect(signup.provider).toBe('Google Workspace');
  });
});

describe('a domain-verification MX in front of the real exchanger', () => {
  it('credits the Workspace tenant behind a priority-0 _dc-mx record', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      {
        ...EMPTY_DNS,
        mx: [
          { priority: 0, host: '_dc-mx.87ecdb0af7a0.example.com' },
          { priority: 1, host: 'aspmx.l.google.com' },
          { priority: 5, host: 'alt1.aspmx.l.google.com' },
        ],
      },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('paid_tenant');
    expect(signup.provider).toBe('Google Workspace');
    expect(signup.matchedHost).toBe('aspmx.l.google.com');
  });

  it('still classifies a disposable exchanger listed beside the verification record', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      {
        ...EMPTY_DNS,
        mx: [
          { priority: 0, host: '_dc-mx.87ecdb0af7a0.example.com' },
          { priority: 10, host: 'mail.guerrillamail.com' },
        ],
      },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('temp_mail');
    expect(signup.provider).toBe('Guerrilla Mail');
  });

  it('inspects the in-zone exchanger behind the verification record, not the record itself', async () => {
    zone({
      'mx.example.com': [
        { name: 'mx.example.com.', type: 5, TTL: 300, data: 'in.mailsac.com.' },
        { name: 'in.mailsac.com.', type: 1, TTL: 300, data: '203.0.113.9' },
      ],
    });

    const signup = await collectSignup(
      'example.com',
      {
        ...EMPTY_DNS,
        mx: [
          { priority: 0, host: '_dc-mx.98d46ad589ea.example.com' },
          { priority: 10, host: 'mx.example.com' },
        ],
      },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('temp_mail');
    expect(signup.provider).toBe('Mailsac');
    expect(signup.matchedVia).toBe('cname');
    expect(signup.matchedHost).toBe('in.mailsac.com');
  });
});

describe('mail exchangers published in a provider setup page', () => {
  it('classifies the domains Guerrilla Mail lists on its own homepage', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mail.pokemail.net' }] },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('temp_mail');
    expect(signup.provider).toBe('Guerrilla Mail');
  });

  it('classifies the backup exchanger on Mailsac DNS verification page', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 5, host: 'alt.mailsac.com' }] },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('temp_mail');
    expect(signup.provider).toBe('Mailsac');
  });
});

describe('mail exchangers taken from a provider setup page', () => {
  it('credits Proofpoint Essentials on the host the vendor publishes', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mx1-us1.ppe-hosted.com' }] },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('paid_tenant');
    expect(signup.provider).toBe('Proofpoint');
  });

  it('credits Alibaba Mail and does not credit the rest of Alibaba Cloud', async () => {
    zone({});

    const paid = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 5, host: 'mx1.qiye.aliyun.com' }] },
      undefined,
      2_000,
    );
    const other = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mx1.aliyun.com' }] },
      undefined,
      2_000,
    );

    expect(paid.class).toBe('paid_tenant');
    expect(paid.provider).toBe('Alibaba Mail');
    expect(other.class).not.toBe('paid_tenant');
  });

  it('treats GoDaddy mail as ambiguous, because forwarding and Professional Email share exchangers', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 0, host: 'smtp.secureserver.net' }] },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('ambiguous_routing');
    expect(signup.provider).toBe('GoDaddy mail');
  });

  it('does not pay the tenancy credit for Hostinger Email', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 5, host: 'mx1.hostinger.com' }] },
      undefined,
      2_000,
    );

    expect(signup.class).not.toBe('paid_tenant');
  });

  it('classifies a 1secmail domain and a generator.email exchanger as throwaway inboxes', async () => {
    zone({});

    const secmail = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mail.esiix.com' }] },
      undefined,
      2_000,
    );
    const generator = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'generator.email' }] },
      undefined,
      2_000,
    );

    expect(secmail.class).toBe('temp_mail');
    expect(secmail.provider).toBe('1secmail');
    expect(generator.class).toBe('temp_mail');
    expect(generator.provider).toBe('Generator.email');
  });
});

describe('ambiguous free-or-paid mail exchangers', () => {
  it('classifies Zoho as ambiguous_routing rather than free_routing', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mx.zoho.com' }] },
      undefined,
      2_000,
    );

    expect(signup.class).toBe('ambiguous_routing');
    expect(signup.provider).toBe('Zoho Mail');
    expect(signup.matchedVia).toBe('mx');
  });

  it('corroborates ImprovMX from the SPF include its own setup instructions require', async () => {
    zone({});

    const signup = await collectSignup(
      'example.com',
      { ...EMPTY_DNS, mx: [{ priority: 10, host: 'mx1.improvmx.com' }] },
      'v=spf1 include:spf.improvmx.com ~all',
      2_000,
    );

    expect(signup.class).toBe('free_routing');
    expect(signup.corroboration).toEqual(["SPF includes the provider's routing sender policy"]);
  });
});
