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
  { provider: 'StartMail', patterns: ['startmail.com'] },
  { provider: 'AliasVault', patterns: ['aliasvault.net'] },
  { provider: 'Erine.email', patterns: ['erine.email'] },
  { provider: '33mail', patterns: ['33mail.com'] },
  { provider: 'Spamgourmet', patterns: ['spamgourmet.com'] },
];

/**
 * Shared relay domains, matched against the *submitted domain* rather than against its MX.
 *
 * A relay user receives mail at the provider's own domain and never points their own MX, so there is
 * no MX fingerprint to find. This remains a domain-level property rather than a local-part heuristic,
 * which is why it survived the removal of local-part scoring.
 */
export const RELAY_DOMAINS: readonly string[] = [
  'mozmail.com',
  'duck.com',
  'privaterelay.appleid.com',
  'simplelogin.com',
  'simplelogin.co',
  'simplelogin.io',
  'slmail.me',
  'aleeas.com',
  'passinbox.com',
  'passmail.net',
  'passfwd.com',
  'anonaddy.com',
  'anonaddy.me',
  'addy.io',
  'addymail.com',
  'aliasvault.net',
  'relay.firefox.com',
  '33mail.com',
  'spamgourmet.com',
  'burnermail.io',
];
