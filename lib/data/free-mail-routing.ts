import type { MxFingerprint } from './mx-match';

/**
 * Free custom-domain mail routing: services that accept mail for *any* domain you own, at no cost, with
 * catch-all and unlimited aliases.
 *
 * This is the capability an account farmer needs, and it is the sharpest single fingerprint available,
 * because it is the one class of mail hosting where the marginal cost of another domain and another
 * thousand addresses is zero.
 *
 * Routing alone stays a moderate penalty rather than a decisive one, since hobbyists use these services
 * legitimately. The decisive weight lives in the combination with youth and the absence of a website,
 * where the hobbyist explanation no longer holds.
 *
 * The weakest members are the providers whose free and paid tiers share mail exchangers, since the two
 * cannot be told apart from DNS alone.
 */
export const FREE_MAIL_ROUTING_MX: readonly MxFingerprint[] = [
  {
    provider: 'Cloudflare Email Routing',
    // Suffix match: the routing hostnames are per-account and versioned, so matching exact names would
    // miss most of the population.
    patterns: ['.mx.cloudflare.net', 'mx.cloudflare.net'],
    note: 'free on any domain, catch-all plus unlimited aliases',
  },
  {
    provider: 'registrar free email forwarding',
    patterns: ['registrar-servers.com'],
    note: 'bundled free with any domain at the registrar, catch-all capable',
  },
  { provider: 'ImprovMX', patterns: ['improvmx.com'], note: 'free tier forwards any domain' },
  { provider: 'ForwardEmail', patterns: ['forwardemail.net'], note: 'free tier forwards any domain' },
  {
    provider: 'Zoho Mail',
    patterns: ['zoho.com', 'zoho.eu', 'zohomail.com'],
    note: 'free and paid tiers share mail exchangers and cannot be distinguished from DNS',
  },
  { provider: 'Migadu', patterns: ['migadu.com'] },
  { provider: 'Yandex Mail for Domain', patterns: ['mx.yandex.net', 'yandex.net', 'yandex.ru'] },
  { provider: 'Purelymail', patterns: ['purelymail.com'] },
  { provider: 'Mailfence', patterns: ['mailfence.com'] },
];

/**
 * Corroboration for the free-routing fingerprint that dominates this class, verified during design.
 * Held as data so the collector can confirm the match two further ways when the MX hostname alone is
 * ambiguous: every routing target resolves inside one small prefix, and the provider publishes a
 * well-known SPF include.
 */
export const CLOUDFLARE_ROUTING = {
  mxSuffix: '.mx.cloudflare.net',
  targetPrefix: '162.159.205.',
  spfInclude: '_spf.mx.cloudflare.net',
} as const;

/**
 * Paid mail tenancy: a positive signal, because someone is paying per seat for this domain's mail.
 *
 * Weak rather than conclusive, since the major business suites all offer trials and cheap entry tiers
 * that an abuser can reach. It earns a small bonus and participates in the conclusive-legitimacy
 * override only alongside a vetted suffix and real age.
 */
export const PAID_MAIL_MX: readonly MxFingerprint[] = [
  { provider: 'Google Workspace', patterns: ['aspmx.l.google.com', 'googlemail.com', 'google.com'] },
  { provider: 'Microsoft 365', patterns: ['mail.protection.outlook.com', 'outlook.com'] },
  { provider: 'Proofpoint', patterns: ['pphosted.com'] },
  { provider: 'Mimecast', patterns: ['mimecast.com', 'mimecast.co.za'] },
  { provider: 'Barracuda', patterns: ['barracudanetworks.com'] },
  { provider: 'Fastmail', patterns: ['messagingengine.com', 'fastmail.com'] },
  { provider: 'registrar paid mailbox product', patterns: ['privateemail.com', 'web-hosting.com'] },
  { provider: 'Proton Mail paid custom domain', patterns: ['protonmail.ch', 'proton.me', 'protonmail.com'] },
  { provider: 'Rackspace Email', patterns: ['emailsrvr.com'] },
  { provider: 'Titan Mail', patterns: ['titan.email'] },
  { provider: 'MXroute', patterns: ['mxrouting.net'] },
  { provider: 'Cisco Secure Email', patterns: ['iphmx.com'] },
  { provider: 'Trend Micro Email Security', patterns: ['trendmicro.com'] },
  { provider: 'Sophos Email', patterns: ['sophos.com'] },
  { provider: 'StackMail', patterns: ['stackmail.com'] },
];

/**
 * Shared consumer mail infrastructure found on someone else's domain.
 *
 * Large free mail providers operate hundreds of alternative vanity domains, so a hardcoded list of
 * consumer providers will always be incomplete. Matching the *mail exchanger* instead catches them
 * generically: a domain whose mail is handled by consumer mail infrastructure is itself a shared free
 * provider with many unrelated users, and scoring it as one organisation's domain is as meaningless as
 * scoring the provider's main domain.
 *
 * A match routes the analysis to `out_of_scope: shared_free_provider` rather than applying a penalty.
 */
export const CONSUMER_MAIL_INFRASTRUCTURE_MX: readonly MxFingerprint[] = [
  { provider: 'GMX / Mail & Media', patterns: ['gmx.net', 'gmx.com', 'gmx.de'] },
  { provider: 'mail.com', patterns: ['mail.com'] },
  { provider: 'Web.de', patterns: ['web.de'] },
  { provider: 'Freenet', patterns: ['freenet.de'] },
  { provider: 'Yahoo / AOL consumer mail', patterns: ['yahoodns.net', 'aol.com'] },
  { provider: 'Mail.ru', patterns: ['mail.ru'] },
  { provider: 'QQ Mail', patterns: ['qq.com'] },
  { provider: 'NetEase Mail', patterns: ['163.com', '126.com'] },
  { provider: 'Naver Mail', patterns: ['naver.com'] },
  { provider: 'Daum Mail', patterns: ['daum.net'] },
];
