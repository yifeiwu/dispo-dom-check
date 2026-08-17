import type { MxFingerprint } from './mx-match';

/**
 * Alias forwarders: services whose purpose is issuing unlimited addresses that land in one real
 * mailbox.
 *
 * These are flagged, not penalised into the ground. They are legitimate privacy tools that happen to
 * also be ideal for multi-account creation, so whether an alias address is acceptable at signup is the
 * consumer's policy decision, and the model surfaces a `forwarder` flag rather than making it.
 */
export const FORWARDER_MX: readonly MxFingerprint[] = [
  { provider: 'SimpleLogin', patterns: ['simplelogin.co', 'simplelogin.io'] },
  { provider: 'addy.io', patterns: ['anonaddy.me', 'anonaddy.com', 'addy.io'] },
  { provider: 'DuckDuckGo Email Protection', patterns: ['duck.com'] },
  { provider: 'Firefox Relay', patterns: ['mozmail.com', 'relay.firefox.com'] },
  { provider: 'AliasVault', patterns: ['aliasvault.net'] },
  { provider: 'Erine.email', patterns: ['erine.email'] },
  { provider: '33mail', patterns: ['33mail.com'] },
  { provider: 'Spamgourmet', patterns: ['spamgourmet.com'] },
  /*
   * Held here rather than in the temp-mail table, where it sat until the two were reconciled. A Burner
   * Mail alias is permanent until its owner deletes it and forwards to a mailbox the owner already had,
   * which is the alias arrangement this table describes and not the throwaway inbox the other one does.
   * `burnermail.io` was already listed as a relay domain below, so the tables disagreed by 28 points
   * about one provider depending on which side of the arrangement was observed.
   */
  { provider: 'Burner Mail', patterns: ['burnermail.io'] },
];

/**
 * Shared relay domains, matched against the *submitted domain* rather than against its MX.
 *
 * A relay user receives mail at the provider's own domain and never points their own MX, so there is
 * no MX fingerprint to find. This remains a domain-level property rather than a local-part heuristic,
 * which is why it survived the removal of local-part scoring.
 *
 * Entries have to be domains that actually carry mail. `relay.firefox.com` sat here and was removed for
 * failing that: it is the service's website, and every Firefox Relay alias is issued at `mozmail.com`,
 * which is listed. A name no address can end in costs a comparison on every analysis to match nothing.
 */
export const RELAY_DOMAINS: readonly string[] = [
  'mozmail.com',
  'duck.com',
  'privaterelay.appleid.com',
  // The eight names SimpleLogin itself publishes as the set it issues aliases under.
  'simplelogin.com',
  'simplelogin.co',
  'simplelogin.io',
  'simplelogin.fr',
  'slmail.me',
  'slmails.com',
  'silomails.com',
  'aleeas.com',
  'passinbox.com',
  'passmail.net',
  'passfwd.com',
  // addy.io: the first two are the free plan's, the rest are reachable on a paid one.
  'anonaddy.com',
  'anonaddy.me',
  'addy.io',
  'addymail.com',
  '4wrd.cc',
  'mailer.me',
  'addy.to',
  'aliasvault.net',
  /*
   * Sourced from a decade of press coverage of the product rather than from a current provider page, so
   * it is the weakest entry in the list. It is kept because the direction of a stale relay domain is
   * safe: the service is long-lived and the flag it sets carries no points, so being wrong here reports
   * a capability nobody has rather than penalising anybody for it.
   */
  'opayq.com',
  '33mail.com',
  'spamgourmet.com',
  'burnermail.io',
  'erine.email',
  // StartMail issues aliases here rather than at its own apex, which is where a paying customer's real
  // mailbox lives. The apex is a paid mail tenancy and is fingerprinted as one.
  'use.startmail.com',
];
