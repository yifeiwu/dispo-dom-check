import { parse } from 'tldts';
import { isConsumerMailProvider } from './data/consumer-mail-providers';
import { matchProviderSuffix, type ProviderSuffix } from './data/provider-suffixes';
import { matchVettedSuffix } from './data/vetted-tlds';
import { RELAY_DOMAINS } from './data/forwarder-mx';
import { readHost, type RejectionReason } from './domain-syntax';

export { isIpLiteral, isReservedName, type RejectionReason } from './domain-syntax';

/**
 * Input normalisation, and the gate that decides whether an input is worth analysing at all.
 *
 * A full email address is accepted as an input convenience, because that is the form a consumer
 * actually holds, and the local part is discarded here at the boundary. It is never returned, never
 * stored and never logged: nothing downstream of this module can see it, which is enforced by the
 * shape of `NormalisedInput` rather than by convention.
 */

export type OutOfScopeReason = 'shared_free_provider';

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

export function normaliseInput(raw: string): NormalisedInput {
  // Every rejection that does not need the suffix list, decided by the module the browser also runs so
  // that client and server cannot disagree about what a domain is.
  const syntax = readHost(raw);
  if (syntax.kind === 'rejected') return syntax;

  const { host, fromEmailAddress } = syntax;

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
