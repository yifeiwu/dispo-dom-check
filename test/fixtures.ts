import type { DomainFacts, DnsFacts, MailFacts, SiteFacts } from '@/lib/facts';
import { nameFacts } from '@/lib/scoring/signals';

/**
 * Fixtures are raw facts snapshots, which is the point of separating collection from scoring: a weight
 * change can be re-tested offline with no network and no risk of a source having changed underneath the
 * test.
 *
 * Each fixture describes a *profile* rather than a particular domain, and uses reserved example names, so
 * the labelled benchmark stays a genuine holdout. Nothing measured from it is encoded here.
 */

const NOW = '2026-06-01T00:00:00.000Z';

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

function yearsAhead(years: number): string {
  return new Date(Date.parse(NOW) + years * 31_557_600_000).toISOString();
}

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

const EMPTY_MAIL: MailFacts = {
  spfIncludes: [],
  spfPaidSenders: [],
  dmarcStrictAlignment: false,
  dmarcRua: [],
  dkimSelectors: [],
  dkimKeys: [],
  saasVendors: [],
};

const NO_SITE: SiteFacts = {
  reachable: false,
  redirectedOffDomain: false,
  substantive: false,
  parked: false,
  titleMatchesDomain: false,
};

const LIVE_SITE: SiteFacts = {
  reachable: true,
  status: 200,
  finalUrl: 'https://example.com/',
  title: 'Example',
  contentLength: 4200,
  substantive: true,
  parked: false,
  titleMatchesDomain: true,
  redirectedOffDomain: false,
};

/**
 * Every source answered, so a fixture exercises band logic rather than the confidence floor.
 *
 * WHOIS is skipped rather than answered, which is the normal case: RDAP answered for these profiles, and
 * the port-43 collector runs only where it did not.
 */
const ALL_OK: DomainFacts['sources'] = [
  { source: 'dns', status: 'ok', elapsedMs: 10 },
  { source: 'rdap', status: 'ok', elapsedMs: 10 },
  { source: 'whois', status: 'skipped', reason: 'The registry publishes RDAP', elapsedMs: 0 },
  { source: 'mail', status: 'ok', elapsedMs: 10 },
  { source: 'signup', status: 'ok', elapsedMs: 10 },
  { source: 'pricing', status: 'ok', elapsedMs: 10 },
  { source: 'site', status: 'ok', elapsedMs: 10 },
];

export function facts(overrides: Partial<DomainFacts> = {}): DomainFacts {
  const label = overrides.meta?.label ?? 'example';
  return {
    meta: {
      domain: 'example.com',
      suffix: 'com',
      label,
      submittedHost: 'example.com',
      fromEmailAddress: false,
      relayDomain: false,
      analysedAt: NOW,
      ...overrides.meta,
    },
    dns: EMPTY_DNS,
    mail: EMPTY_MAIL,
    site: NO_SITE,
    signup: { class: 'none', selfHosted: false },
    name: nameFacts(label),
    sources: ALL_OK,
    ...overrides,
  };
}

/**
 * The reference false-positive case: a legitimate low-traffic small business, more than a decade old, with
 * none of the modern mail hygiene. It has no DMARC, no DNSSEC and no vendor verification records.
 *
 * This profile is what forced the correlated-absence discount group and the rule that absent hygiene
 * records are never penalised on their own. If a change to the weights pushes this out of the established
 * band, the change is charging ordinary businesses for being unsophisticated.
 */
export const establishedSmallBusiness = (): DomainFacts =>
  facts({
    registration: {
      via: 'rdap',
      creation: daysAgo(4600),
      expiry: yearsAhead(0.6),
      statuses: ['clienttransferprohibited'],
      registrar: 'a mainstream registrar',
      nameservers: ['ns1.example.net', 'ns2.example.net'],
      // Redaction is the norm and must not be penalised, so the reference case has it.
      registrantIsPrivacyService: true,
    },
    dns: {
      ...EMPTY_DNS,
      a: ['203.0.113.10'],
      ns: ['ns1.example.net', 'ns2.example.net'],
      mx: [{ priority: 10, host: 'mail.example.com' }],
      txt: ['v=spf1 include:_spf.example.net ~all'],
      wwwExists: true,
      mailHostExists: true,
    },
    mail: { ...EMPTY_MAIL, spf: 'v=spf1 include:_spf.example.net ~all', spfIncludes: ['_spf.example.net'] },
    signup: { class: 'self_hosted', matchedHost: 'mail.example.com', selfHosted: true },
    pricing: { suffix: 'com', registration: 10.5, renewal: 11.2, renewalRatio: 1.07 },
    site: LIVE_SITE,
  });

/** Mail handled by a throwaway-inbox service: the closest thing to conclusive in this model. */
export const tempMailDomain = (): DomainFacts =>
  facts({
    registration: { via: 'rdap', creation: daysAgo(200), expiry: yearsAhead(0.5), statuses: [], nameservers: [], termYears: 1 },
    dns: {
      ...EMPTY_DNS,
      a: ['203.0.113.20'],
      mx: [{ priority: 10, host: 'mail.guerrillamail.com' }],
    },
    signup: {
      class: 'temp_mail',
      provider: 'a throwaway-inbox service',
      matchedHost: 'mail.guerrillamail.com',
      selfHosted: false,
    },
    pricing: { suffix: 'com', registration: 10.5, renewal: 11.2, renewalRatio: 1.07 },
  });

/** The account-farm profile: cheap suffix, first term, mail configured, nothing served. */
export const farmProfileDomain = (): DomainFacts =>
  facts({
    meta: {
      domain: 'example.sbs',
      suffix: 'sbs',
      label: 'signup4821',
      submittedHost: 'example.sbs',
      fromEmailAddress: false,
      relayDomain: false,
      analysedAt: NOW,
    },
    registration: { via: 'rdap', creation: daysAgo(21), expiry: yearsAhead(0.94), statuses: [], nameservers: [], termYears: 1 },
    dns: {
      ...EMPTY_DNS,
      mx: [{ priority: 10, host: 'route1.mx.cloudflare.net' }],
      ns: ['ns1.example.net'],
    },
    signup: {
      class: 'free_routing',
      provider: 'a free custom-domain routing service',
      matchedHost: 'route1.mx.cloudflare.net',
      corroboration: ['Mail exchanger resolves inside the provider\'s dedicated routing prefix'],
      selfHosted: false,
    },
    pricing: { suffix: 'sbs', registration: 1.6, renewal: 24, renewalRatio: 15 },
  });

/** A registrar's untouched DNS template plus bundled forwarding on a young mail-only domain. */
export const registrarDefaultFarm = (): DomainFacts => {
  const profile = farmProfileDomain();
  profile.registration = {
    ...profile.registration!,
    registrar: 'Namecheap, Inc.',
    registrarIanaId: '1068',
    nameservers: ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'],
  };
  profile.dns = {
    ...profile.dns!,
    ns: ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'],
    mx: [{ priority: 10, host: 'eforward1.registrar-servers.com' }],
  };
  profile.signup = {
    class: 'free_routing',
    provider: 'registrar free email forwarding',
    matchedHost: 'eforward1.registrar-servers.com',
    selfHosted: false,
  };
  profile.registrarDefault = {
    provider: 'Namecheap',
    nameserver: 'dns1.registrar-servers.com',
    forwardingMx: 'eforward1.registrar-servers.com',
  };
  return profile;
};

/**
 * A young domain doing the minimum that can be observed rather than asserted: it resolves, serves a
 * page, receives mail and publishes a bare sending policy.
 *
 * It carries an SPF record so that the pairing penalty for a live site with no policy at all fires in
 * neither this profile nor the one below, leaving the self-asserted records as the only difference
 * between them.
 */
export const modestNewBusiness = (): DomainFacts =>
  facts({
    registration: {
      via: 'rdap',
      creation: daysAgo(60),
      expiry: yearsAhead(0.84),
      statuses: [],
      registrar: 'a mainstream registrar',
      nameservers: ['ns1.example.net'],
      termYears: 1,
    },
    dns: {
      ...EMPTY_DNS,
      a: ['203.0.113.50'],
      ns: ['ns1.example.net'],
      mx: [{ priority: 10, host: 'mail.example.com' }],
      txt: ['v=spf1 -all'],
      wwwExists: true,
      mailHostExists: true,
    },
    mail: { ...EMPTY_MAIL, spf: 'v=spf1 -all' },
    signup: { class: 'self_hosted', matchedHost: 'mail.example.com', selfHosted: true },
    pricing: { suffix: 'com', registration: 10.5, renewal: 11.2, renewalRatio: 1.07 },
    site: LIVE_SITE,
  });

/**
 * The same domain, having also published every record the model stopped scoring in 1.3.0 and still
 * reports: five vendor verification strings, DKIM keys, an enforcing DMARC policy with strict alignment
 * and an explicit subdomain policy, a paid sending platform named in SPF, and a commercial reporting
 * vendor that has not vouched for it.
 *
 * BIMI and business services are absent because they are no longer collected. They were the withdrawn
 * credits whose records cost a lookup of their own, so they were deleted rather than left to be reported
 * unweighed, and there is nothing left to assert here.
 *
 * Every one of these is a string this domain publishes in its own zone, free to write and checked
 * against nobody, so the two profiles must score identically. If they ever diverge, the model has
 * grown a credit an account farmer can mint from a text editor.
 *
 * DNSSEC is deliberately not among them. It is the one member of the footprint dimension that still
 * scores, because the resolver validates it, so adding it here would be a real difference rather than
 * an asserted one.
 */
export const selfAssertedRecords = (): DomainFacts => {
  const profile = modestNewBusiness();
  profile.dns = {
    ...profile.dns!,
    txt: [
      'v=spf1 include:sendgrid.net -all',
      'google-site-verification=Zm9ydHktdGhyZWUtY2hhcmFjdGVycy1vZi1iYXNlNjR1cmw',
      'facebook-domain-verification=c2l4dGVlbmNoYXJz',
      'stripe-verification=dGhpcyBpcyBub3QgYSByZWFsIHRva2Vu',
      'slack-domain-verification=bm9yIGlzIHRoaXMgb25l',
      'atlassian-domain-verification=bm9yIHRoaXMgb25lIGVpdGhlcg',
    ],
  };
  profile.mail = {
    ...profile.mail!,
    spf: 'v=spf1 include:sendgrid.net -all',
    spfAllQualifier: '-all',
    spfIncludes: ['sendgrid.net'],
    spfPaidSenders: ['SendGrid'],
    dmarc: 'v=DMARC1; p=reject; sp=reject; aspf=s; rua=mailto:reports@dmarcian.com',
    dmarcPolicy: 'reject',
    dmarcSubdomainPolicy: 'reject',
    dmarcStrictAlignment: true,
    dmarcRua: ['reports@dmarcian.com'],
    dmarcRuaCommercialVendor: 'dmarcian.com',
    // The vendor published no authorisation record, which is what naming a vendor you have no
    // account with looks like from DNS.
    dmarcRuaVerified: false,
    dkimSelectors: ['default'],
    dkimKeys: [{ selector: 'default' }],
    saasVendors: ['Atlassian', 'Google', 'Meta', 'Slack', 'Stripe'],
  };
  return profile;
};

/** An alias forwarder, which is flagged for the consumer's policy rather than condemned. */
export const forwarderDomain = (): DomainFacts =>
  facts({
    registration: { via: 'rdap', creation: daysAgo(1500), expiry: yearsAhead(1), statuses: [], nameservers: [] },
    dns: { ...EMPTY_DNS, a: ['203.0.113.30'], mx: [{ priority: 10, host: 'mx1.simplelogin.co' }] },
    signup: {
      class: 'forwarder',
      provider: 'an alias forwarding service',
      matchedHost: 'mx1.simplelogin.co',
      selfHosted: false,
    },
    pricing: { suffix: 'com', registration: 10.5, renewal: 11.2, renewalRatio: 1.07 },
  });

/** A name issued under a platform suffix, where registration facts belong to the provider. */
export const providerSubdomain = (): DomainFacts =>
  facts({
    meta: {
      domain: 'tenant.pages.dev',
      suffix: 'pages.dev',
      label: 'tenant',
      submittedHost: 'tenant.pages.dev',
      fromEmailAddress: false,
      relayDomain: false,
      analysedAt: NOW,
      providerSuffix: { suffix: 'pages.dev', provider: 'a hosting platform', kind: 'platform' },
    },
    dns: { ...EMPTY_DNS, a: ['203.0.113.40'] },
    site: LIVE_SITE,
    sources: [
      { source: 'dns', status: 'ok', elapsedMs: 10 },
      { source: 'rdap', status: 'skipped', reason: 'Registration belongs to the platform', elapsedMs: 0 },
      { source: 'whois', status: 'skipped', reason: 'Registration belongs to the platform', elapsedMs: 0 },
      { source: 'mail', status: 'ok', elapsedMs: 10 },
      { source: 'signup', status: 'ok', elapsedMs: 10 },
      { source: 'pricing', status: 'skipped', reason: 'No registry price', elapsedMs: 0 },
      { source: 'site', status: 'ok', elapsedMs: 10 },
    ],
  });

/** Parked, but with working mail: parking normally implies no mail at all. */
export const parkedWithMail = (): DomainFacts =>
  facts({
    registration: { via: 'rdap', creation: daysAgo(700), expiry: yearsAhead(0.4), statuses: [], nameservers: [] },
    dns: {
      ...EMPTY_DNS,
      a: ['203.0.113.50'],
      mx: [{ priority: 10, host: 'mail.example.com' }],
      ns: ['ns1.parkingcrew.net'],
    },
    signup: { class: 'self_hosted', selfHosted: true },
    site: {
      ...NO_SITE,
      reachable: true,
      status: 200,
      parked: true,
      parkingEvidence: 'Delegated to a parking service',
    },
    pricing: { suffix: 'com', registration: 10.5, renewal: 11.2, renewalRatio: 1.07 },
  });

/** An accredited suffix, real age and a paid mail tenant: the positive override. */
export const accreditedInstitution = (): DomainFacts =>
  facts({
    meta: {
      domain: 'example.edu.au',
      suffix: 'edu.au',
      label: 'example',
      submittedHost: 'students.example.edu.au',
      fromEmailAddress: true,
      relayDomain: false,
      vettedSuffix: 'edu.au',
      analysedAt: NOW,
    },
    registration: { via: 'rdap', creation: daysAgo(3000), expiry: yearsAhead(1), statuses: [], nameservers: [] },
    dns: {
      ...EMPTY_DNS,
      a: ['203.0.113.60'],
      mx: [{ priority: 10, host: 'example-edu-au.mail.protection.outlook.com' }],
      wwwExists: true,
    },
    signup: {
      class: 'paid_tenant',
      provider: 'a paid business mail suite',
      matchedHost: 'example-edu-au.mail.protection.outlook.com',
      selfHosted: false,
    },
    pricing: { suffix: 'edu.au', unpriced: true },
    site: LIVE_SITE,
  });

/** Almost nothing answered, which must produce a withheld verdict rather than a guess. */
export const nothingObserved = (): DomainFacts =>
  facts({
    dns: undefined,
    mail: undefined,
    site: undefined,
    signup: undefined,
    sources: [
      { source: 'dns', status: 'timeout', reason: 'No response', elapsedMs: 4000 },
      { source: 'rdap', status: 'unavailable', reason: 'HTTP 503', elapsedMs: 900 },
      { source: 'whois', status: 'skipped', reason: 'The registry publishes RDAP', elapsedMs: 0 },
      { source: 'mail', status: 'timeout', reason: 'No response', elapsedMs: 4000 },
      { source: 'signup', status: 'unavailable', reason: 'No DNS', elapsedMs: 0 },
      { source: 'pricing', status: 'timeout', reason: 'No response', elapsedMs: 8000 },
      { source: 'site', status: 'unavailable', reason: 'Connection refused', elapsedMs: 500 },
    ],
  });
