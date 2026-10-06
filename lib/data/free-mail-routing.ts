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
 * Providers whose free and paid tiers share mail exchangers do not belong here. Scoring them as
 * unlimited free routing is what produced most of the remaining false positives, and leaving them
 * unmatched would drop real farm domains that use the free tier. They live in `AMBIGUOUS_MAIL_MX`,
 * a weaker class that does not fire the young-and-siteless conjunction.
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
];

/*
 * Migadu, Yandex, Purelymail and Mailfence were here and are now in `AMBIGUOUS_MAIL_MX`.
 *
 * They were the four entries carrying no `note`, where the four that remain each state the basis of
 * their membership, and the missing note was the finding rather than a formatting lapse: none of them
 * offers the free unlimited custom-domain routing this table is defined by. Custom domains are a paid
 * feature at Migadu, Purelymail and Mailfence, and Yandex closed its free domain tier to new users.
 * That is the Porkbun test applied a second time — an entry that fails the criterion does not belong
 * regardless of how much it looks like one — and this table carries the heaviest signup penalty plus
 * the young-and-siteless conjunction, so an unevidenced member here is expensive.
 *
 * `PAID_MAIL_MX` was the obvious destination and was declined. The precedent there is StartMail, Titan
 * and MXroute, admitted on having no free tier, and its stated criterion is spend per mailbox rather
 * than how many addresses a mailbox answers to. These three fail that: Purelymail is a flat ten dollars
 * a year for unlimited domains and unlimited addresses, and Migadu prices by message volume rather than
 * by seat, so the marginal cost of the thousandth address is close enough to zero that crediting it as
 * paid tenancy would hand a farm-friendly provider a bonus. Neither a penalty for free routing nor a
 * credit for paid tenancy is defensible, which is exactly what the ambiguous class is for.
 *
 * Together they matched 2 of the 4,685 holdout domains, both abuse, so this is a false-positive
 * exposure removed rather than a measured gain given up.
 */

/**
 * Mail exchangers that a free unlimited-alias product and a paid mailbox product share, so DNS cannot
 * tell which the domain is on.
 *
 * Zoho sat in `FREE_MAIL_ROUTING_MX` until that table's own membership test was applied to it: the
 * note it already carried said the tiers are indistinguishable, and the holdout's remaining
 * false positives concentrate on free-routing matches. A paid Zoho Mail tenant is a small business,
 * which is the expensive error; a free Zoho custom domain is still catch-all capable, which is why
 * this is a weaker class rather than unmatched.
 */
export const AMBIGUOUS_MAIL_MX: readonly MxFingerprint[] = [
  {
    provider: 'Zoho Mail',
    patterns: ['zoho.com', 'zoho.eu', 'zohomail.com'],
    note: 'free and paid tiers share mail exchangers and cannot be distinguished from DNS',
  },
  /*
   * The four that moved out of `FREE_MAIL_ROUTING_MX`. Zoho is here because its free and paid tiers are
   * indistinguishable; these are here for the adjacent reason that they are cheap and unmetered per
   * address without being free, so neither the free-routing penalty nor the paid-tenancy credit tells
   * the truth about them. Each note now states what the old entries left unstated.
   */
  {
    provider: 'Migadu',
    patterns: ['migadu.com'],
    note: 'paid only, but priced by message volume rather than per mailbox, so addresses are unmetered',
  },
  {
    provider: 'Yandex Mail for Domain',
    patterns: ['mx.yandex.net', 'yandex.net', 'yandex.ru'],
    note: 'free domain tier closed to new users, so a match may be grandfathered free or paid',
  },
  {
    provider: 'Purelymail',
    patterns: ['purelymail.com'],
    note: 'paid only, at a flat yearly fee for unlimited domains and unlimited addresses',
  },
  {
    provider: 'Mailfence',
    patterns: ['mailfence.com'],
    note: 'custom domains require a paid plan, while the free tier is mailfence.com addresses only',
  },
  /*
   * GoDaddy publishes the same two exchangers for Professional Email, which is billed per mailbox, and
   * for Email Forwarding, which is the bundled redirect. DNS cannot tell a paying tenant from a
   * forward, so neither the paid credit nor the free-routing penalty is defensible. This is the Zoho
   * case. `smtp.secureserver.net` was already declined for the registrar-default table for the first
   * half of that reason.
   */
  {
    provider: 'GoDaddy mail',
    patterns: ['secureserver.net'],
    note: 'Professional Email and Email Forwarding publish the same exchangers',
  },
];

/*
 * Porkbun's free forwarding (`fwd1.porkbun.com`, `fwd2.porkbun.com`) was added here and taken out again,
 * recorded so that the next reader does not repeat the work. It looks like the registrar entry above and
 * is not: the registrar publishes that catch-all and wildcard forwarding are unsupported and that a
 * domain gets twenty addresses, so the marginal cost of the thousandth address is not zero, it is
 * unavailable. That is the whole reason this table is weighted as heavily as it is, and an entry that
 * fails it does not belong regardless of the service being free.
 *
 * It is left unmatched rather than moved somewhere gentler. There is no class here for bounded cheap
 * aliasing, inventing one to hold a single provider would be a table built for an audience of one, and
 * `unknown_host` already says the true thing: nothing about this domain's mail is known to be cheap.
 */

/**
 * Corroboration for a free-routing fingerprint, held as data so the collector can confirm a match
 * when the MX hostname alone is easy to spoof. Every entry comes from the provider's own setup
 * instructions. A prefix is listed only where the provider publishes a dedicated routing range;
 * an SPF include is enough on its own, and a check the network cuts short is silence rather than
 * disagreement.
 */
export type RoutingCorroboration = {
  mxSuffix: string;
  spfInclude: string;
  targetPrefix?: string;
};

export const ROUTING_CORROBORATION: readonly RoutingCorroboration[] = [
  {
    mxSuffix: '.mx.cloudflare.net',
    targetPrefix: '162.159.205.',
    spfInclude: '_spf.mx.cloudflare.net',
  },
  { mxSuffix: 'improvmx.com', spfInclude: 'spf.improvmx.com' },
  { mxSuffix: 'forwardemail.net', spfInclude: 'spf.forwardemail.net' },
];

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
  { provider: 'Proofpoint', patterns: ['pphosted.com', 'ppe-hosted.com'] },
  { provider: 'Mimecast', patterns: ['mimecast.com', 'mimecast.co.za'] },
  { provider: 'Barracuda', patterns: ['barracudanetworks.com'] },
  { provider: 'Fastmail', patterns: ['messagingengine.com', 'fastmail.com'] },
  { provider: 'registrar paid mailbox product', patterns: ['privateemail.com', 'web-hosting.com'] },
  { provider: 'Proton Mail paid custom domain', patterns: ['protonmail.ch', 'proton.me', 'protonmail.com'] },
  { provider: 'Rackspace Email', patterns: ['emailsrvr.com'] },
  /*
   * Unlimited aliases and unlimited custom domains, which reads like the forwarder table this was moved
   * out of, but there is no free tier behind any of it: every plan is paid after a seven-day trial. The
   * criterion here is spend per mailbox rather than how many addresses a mailbox can answer to.
   */
  { provider: 'StartMail', patterns: ['startmail.com'] },
  { provider: 'Titan Mail', patterns: ['titan.email'] },
  { provider: 'MXroute', patterns: ['mxrouting.net'] },
  { provider: 'Cisco Secure Email', patterns: ['iphmx.com'] },
  { provider: 'Trend Micro Email Security', patterns: ['trendmicro.com'] },
  { provider: 'Sophos Email', patterns: ['sophos.com'] },
  { provider: 'StackMail', patterns: ['stackmail.com'] },
  /*
   * Enterprise mail and the gateways already in this table, from each vendor's own MX instructions.
   * Proofpoint Essentials is the same product family as `pphosted.com`, on `ppe-hosted.com`. Alibaba
   * Mail publishes `qiye.aliyun.com` and the older `mxhichina.com` hosts, and the pattern stops at
   * those names so the rest of Alibaba Cloud is not credited. Symantec Email Security.cloud publishes
   * `cluster*.messagelabs.com`. mailbox.org and Tuta bill per mailbox, cap aliases, and require a paid
   * plan before a custom domain will accept mail, which is the Proton shape rather than the flat
   * unlimited-address shape that lives in the ambiguous table.
   */
  { provider: 'Alibaba Mail', patterns: ['qiye.aliyun.com', 'mxhichina.com'] },
  { provider: 'Symantec Email Security.cloud', patterns: ['messagelabs.com'] },
  { provider: 'mailbox.org', patterns: ['mailbox.org'] },
  { provider: 'Tuta', patterns: ['tutanota.de'] },
];

/*
 * iCloud+ custom domains (`mx01.mail.icloud.com`) were added here and removed, recorded for the same
 * reason as the declined free-routing entry above: it is an obvious-looking member that fails the
 * table's own criterion.
 *
 * Every other member charges for the mailbox: another address means another bill, which is what makes a
 * match evidence of spend on *this* domain. One iCloud+ subscription starts around a dollar a month and
 * carries five domains at three addresses each, so a match evidences a subscription somebody already had
 * for their photographs. That is a credit an operator can mint five times over for the price of one, and
 * a credit nothing can confirm is exactly what the rule about credits exists to keep out.
 *
 * Not being here costs nothing: the exchanger goes unrecognised, the domain scores neutrally on the
 * dimension, and the surrounding signals decide. The claim being declined is only that paying Apple a
 * dollar says something about a domain.
 *
 * Hostinger Email (`mx1.hostinger.com`, `mx2.hostinger.com`) was the next candidate and fails the
 * measurement rather than the price list. The product is billed per mailbox, which is the criterion.
 * On the stored holdout the exchangers appear on 70 abuse domains and no legitimate one, and paying
 * the credit moves 17 of those verdicts, several of them into a legitimate band. A credit whose only
 * measured population is farms that bought the cheapest mailbox is the failure the weight's own
 * rationale already names, so the hosts stay unmatched.
 */

/**
 * Shared consumer mail infrastructure found on someone else's domain.
 *
 * Large free mail providers operate hundreds of alternative vanity domains, so a hardcoded list of
 * consumer providers will always be incomplete. Matching the *mail exchanger* instead catches them
 * generically: a domain whose mail is handled by consumer mail infrastructure is itself a shared free
 * provider with many unrelated users, and scoring it as one organisation's domain is as meaningless as
 * scoring the provider's main domain.
 *
 * A match withholds the verdict as `out_of_scope` rather than applying a penalty, which is the same
 * answer `lib/domain.ts` gives for a provider's main domain before any network work happens.
 *
 * It is worth knowing that this comment described that outcome for three versions while nothing
 * implemented it. The class was set here, checked before the paid table so a provider's vanity domain
 * would not score as a paying business tenant, and then read by nothing at all: not a signal, not an
 * observation, not a flag. The suppression was real and the routing was not, so all 19 holdout domains
 * in the class were scored as ordinary businesses and 15 of them came out `unclear` — a number in the
 * middle of the range, about a mailbox shared by millions. `lib/scoring/verdict.ts` now carries the
 * decision and `lib/scoring/score.ts` the predicate.
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
