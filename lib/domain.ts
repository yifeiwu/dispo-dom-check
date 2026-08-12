import { parse } from 'tldts';
import { isConsumerMailProvider } from './data/consumer-mail-providers';
import { matchProviderSuffix, type ProviderSuffix } from './data/provider-suffixes';
import { matchVettedSuffix } from './data/vetted-tlds';
import { RELAY_DOMAINS } from './data/forwarder-mx';

/**
 * Input normalisation, and the gate that decides whether an input is worth analysing at all.
 *
 * A full email address is accepted as an input convenience, because that is the form a consumer
 * actually holds, and the local part is discarded here at the boundary. It is never returned, never
 * stored and never logged: nothing downstream of this module can see it, which is enforced by the
 * shape of `NormalisedInput` rather than by convention.
 */

export type OutOfScopeReason = 'shared_free_provider';

export type RejectionReason =
  | 'empty'
  | 'malformed'
  | 'ip_address'
  | 'localhost'
  | 'private_suffix'
  | 'unknown_suffix'
  | 'too_long';

export type NormalisedInput =
  | {
      kind: 'ok';
      /** The registrable domain in A-label form, which is what every collector queries. */
      domain: string;
      /** Unicode form for display, identical to `domain` unless the input was an IDN. */
      display: string;
      /** The public suffix, e.g. a single label or a multi-label ccTLD suffix. */
      suffix: string;
      /** The label immediately left of the suffix, used by the name-pattern signals. */
      label: string;
      /** True when the submitted input carried a local part that has now been discarded. */
      fromEmailAddress: boolean;
      /**
       * Set when the name sits under a platform-owned suffix. Registration age, price and registrar
       * all belong to the provider, so those signals are suppressed and the verdict is scoped to the
       * subdomain.
       */
      providerSuffix?: ProviderSuffix;
      /** The full submitted host when it is deeper than the registrable domain. */
      submittedHost: string;
      /** Set when the submitted domain is itself a shared alias-relay domain. */
      relayDomain: boolean;
      /** Set when the suffix is restricted by accreditation rather than sold openly. */
      vettedSuffix?: string;
    }
  | { kind: 'out_of_scope'; domain: string; reason: OutOfScopeReason; explanation: string }
  | { kind: 'rejected'; reason: RejectionReason; explanation: string };

const MAX_INPUT_LENGTH = 253;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = new Set(['localhost', 'local', 'internal', 'test', 'example', 'invalid', 'onion']);

/**
 * An address literal rather than a name.
 *
 * Exported because the boundary is not the only place this question is asked: a redirect target is a
 * host chosen by the domain under analysis, and it has to face the same test the submitted host did.
 */
export function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.includes(':');
}

/** A reserved or special-use name, which has no public registration behind it. */
export function isReservedName(host: string): boolean {
  const lastLabel = host.split('.').pop() ?? '';
  return host === 'localhost' || LOCAL_SUFFIXES.has(lastLabel);
}

/**
 * Reduces an input to the host portion, discarding a local part if one is present.
 * Kept separate and total so it can be tested directly without touching the network.
 */
function extractHost(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  // Tolerate a pasted URL.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/)[0];

  // Discard the local part of an address. Everything before the last `@` goes, and is not retained
  // anywhere, including in error messages.
  const at = value.lastIndexOf('@');
  if (at !== -1) value = value.slice(at + 1);

  // Strip a port and any surrounding brackets from an IPv6 literal.
  value = value.replace(/^\[|\]$/g, '');
  value = value.replace(/:\d+$/, '');
  value = value.replace(/\.$/, '');

  return value || null;
}

export function normaliseInput(raw: string): NormalisedInput {
  if (!raw || !raw.trim()) {
    return { kind: 'rejected', reason: 'empty', explanation: 'Enter a domain or an email address.' };
  }
  if (raw.length > MAX_INPUT_LENGTH * 2) {
    return { kind: 'rejected', reason: 'too_long', explanation: 'That input is too long to be a domain.' };
  }

  const fromEmailAddress = raw.includes('@');
  const host = extractHost(raw);

  if (!host) {
    return { kind: 'rejected', reason: 'malformed', explanation: 'That does not look like a domain.' };
  }
  if (host.length > MAX_INPUT_LENGTH) {
    return { kind: 'rejected', reason: 'too_long', explanation: 'That input is too long to be a domain.' };
  }
  if (isIpLiteral(host)) {
    return {
      kind: 'rejected',
      reason: 'ip_address',
      explanation: 'IP addresses have no registration or mail configuration to analyse.',
    };
  }

  if (isReservedName(host)) {
    return {
      kind: 'rejected',
      reason: 'localhost',
      explanation: 'Reserved and special-use names have no public registration to analyse.',
    };
  }

  // `allowPrivateDomains` makes tldts return the PSL private section, so a platform-issued name is
  // reported at its own boundary rather than at the platform's registrable domain.
  const parsed = parse(host, { allowPrivateDomains: true, detectIp: false });
  const publicParsed = parse(host, { allowPrivateDomains: false, detectIp: false });

  if (!parsed.publicSuffix || !publicParsed.domain) {
    return {
      kind: 'rejected',
      reason: 'unknown_suffix',
      explanation: 'That suffix is not in the public suffix list, so it cannot be a registered domain.',
    };
  }

  // Supplementary table first, because the PSL is incomplete for free-subdomain and dynamic-DNS
  // providers, which is exactly the population that matters here.
  const supplementary = matchProviderSuffix(host);
  const pslPrivate = parsed.domain !== publicParsed.domain ? parsed.publicSuffix : undefined;

  let providerSuffix: ProviderSuffix | undefined = supplementary ?? undefined;
  if (!providerSuffix && pslPrivate && host !== pslPrivate) {
    providerSuffix = { suffix: pslPrivate, provider: pslPrivate, kind: 'platform' };
  }

  // The unit of analysis is the platform-issued name where there is one, otherwise the registrable
  // domain. Without this a platform subdomain would be analysed as the platform itself, inheriting a
  // decade of the provider's age.
  let domain = publicParsed.domain;
  if (providerSuffix && host.endsWith(`.${providerSuffix.suffix}`)) {
    const remainder = host.slice(0, -(providerSuffix.suffix.length + 1)).split('.');
    domain = `${remainder[remainder.length - 1]}.${providerSuffix.suffix}`;
  }

  if (domain === host && providerSuffix?.suffix === host) {
    // The bare platform suffix was submitted, e.g. the provider's own domain. There is no tenant to
    // analyse, so treat it as the provider it is.
    providerSuffix = undefined;
  }

  const suffix =
    providerSuffix && domain.endsWith(providerSuffix.suffix)
      ? providerSuffix.suffix
      : (publicParsed.publicSuffix ?? parsed.publicSuffix);
  const label = domain.slice(0, Math.max(0, domain.length - suffix.length - 1));

  if (!label) {
    return {
      kind: 'rejected',
      reason: 'private_suffix',
      explanation: 'That is a public suffix rather than a registered domain.',
    };
  }

  // Consumer providers short-circuit before any network work. Domain-level reputation is meaningless
  // for a mailbox shared by millions, and the useful signal lives in account behaviour and signup
  // velocity, which this tool cannot see. Returning a score here would invite a consumer to act on it.
  if (isConsumerMailProvider(domain) || isConsumerMailProvider(host)) {
    return {
      kind: 'out_of_scope',
      domain,
      reason: 'shared_free_provider',
      explanation:
        'This is a major consumer mail provider. Domain-level analysis says nothing about an individual account, so no score is produced. Assess these at the account level instead, using signup velocity and behaviour.',
    };
  }

  const asciiDomain = toAscii(domain);

  return {
    kind: 'ok',
    domain: asciiDomain,
    display: domain,
    suffix,
    label,
    fromEmailAddress,
    providerSuffix,
    submittedHost: host,
    relayDomain: RELAY_DOMAINS.includes(domain) || RELAY_DOMAINS.includes(host),
    vettedSuffix: matchVettedSuffix(host) ?? undefined,
  };
}

/**
 * IDN to A-label conversion. This is correctness plumbing rather than a scored signal: without it
 * every lookup for an internationalised name fails. Homoglyph and mixed-script scoring was
 * deliberately excluded, being a brand-impersonation concern rather than an account-farming one.
 */
export function toAscii(domain: string): string {
  try {
    // The URL parser applies UTS-46 for us, which is more correct than a hand-rolled punycode pass.
    const url = new URL(`https://${domain}`);
    return url.hostname;
  } catch {
    return domain;
  }
}
