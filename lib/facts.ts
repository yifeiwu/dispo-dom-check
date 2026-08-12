import type { CollectorResult, CollectorStatus, SourceId } from './collector';
import type { ProviderSuffix } from './data/provider-suffixes';

/**
 * `DomainFacts` is the one normalised output of every collector, and the only input to scoring.
 *
 * The split matters for two reasons the plan depends on. Scoring becomes a pure function of facts plus
 * config with no I/O, so a weight change can be re-tested offline against stored fixtures with no
 * network and no risk of a source having changed underneath the test. And a fixture is just a facts
 * snapshot, so calibration data stays valid even when the upstream services move.
 *
 * Fields are optional throughout, because any source may be missing. `undefined` means "not observed",
 * which the scorer must treat as silence rather than as a negative finding.
 */

export type FactsMeta = {
  /** Registrable domain, or the platform-issued name where the input sat under a platform suffix. */
  domain: string;
  suffix: string;
  label: string;
  submittedHost: string;
  fromEmailAddress: boolean;
  providerSuffix?: ProviderSuffix;
  relayDomain: boolean;
  vettedSuffix?: string;
  analysedAt: string;
};

/**
 * The registration record, normalised to one shape regardless of which protocol produced it.
 *
 * RDAP and WHOIS are the same evidence delivered differently, so they are not kept apart here. Holding
 * them in one field is what lets every age, term, expiry and hold signal work on both without knowing
 * which answered: adding WHOIS coverage for a suffix restores the whole dimension rather than just the
 * one signal somebody remembered to teach about it. `via` records which protocol it came from, because
 * that is a real difference in fidelity that the reader is entitled to see.
 */
export type RegistrationFacts = {
  via: 'rdap' | 'whois';
  creation?: string;
  expiry?: string;
  lastChanged?: string;
  /** Raw EPP status codes, lowercased. */
  statuses: string[];
  registrar?: string;
  registrarIanaId?: string;
  /** Public registrant organisation, absent when redacted by a privacy service. */
  registrantOrg?: string;
  registrantIsPrivacyService?: boolean;
  nameservers: string[];
  /**
   * The purchased term in years, available only while the domain is inside its first registration
   * period. Beyond that, creation-to-expiry spans every renewal and says nothing about what was bought.
   */
  termYears?: number;
  /** How far ahead the registration is paid, measured from now. */
  yearsUntilExpiry?: number;
};

export type DnsFacts = {
  a: string[];
  aaaa: string[];
  ns: string[];
  mx: { priority: number; host: string }[];
  /** Apex TXT records, used for SPF and the SaaS verification census. */
  txt: string[];
  /** Whether a `www` address or CNAME record exists, for record breadth. */
  wwwExists: boolean;
  /** Whether a conventional `mail` host exists, a common self-hosted-mail pattern. */
  mailHostExists: boolean;
  /** DNSSEC validation, taken from the resolver's AD flag rather than a separate query. */
  dnssecValidated: boolean;
  /** Resolver that answered, for the evidence string. */
  resolver: string;
};

export type MailFacts = {
  spf?: string;
  spfAllQualifier?: '+all' | '~all' | '-all' | '?all';
  spfIncludes: string[];
  spfPaidSenders: string[];
  dmarc?: string;
  dmarcPolicy?: 'none' | 'quarantine' | 'reject';
  dmarcSubdomainPolicy?: string;
  dmarcStrictAlignment: boolean;
  dmarcRua: string[];
  dmarcRuaCommercialVendor?: string;
  /**
   * Whether the commercial reporting vendor confirmed this domain, by publishing the authorisation
   * record RFC 7489 §7.1 requires at `<domain>._report._dmarc.<vendor>`.
   *
   * Three states, and the distinction carries a weight. `undefined` means no check was possible:
   * no commercial vendor was named, the destination sits inside the domain's own namespace so no
   * external authorisation applies, or the resolver did not answer. `false` means the query ran and
   * the vendor published nothing, which is what naming a vendor you have no account with looks like.
   * Only `true` is evidence, because only `true` came from somebody other than the domain itself.
   */
  dmarcRuaVerified?: boolean;
  dkimSelectors: string[];
  dkimKeys: { selector: string; cnameTarget?: string; provider?: string }[];
  saasVendors: string[];
};

export type SignupClass =
  | 'temp_mail'
  | 'free_routing'
  | 'forwarder'
  | 'paid_tenant'
  | 'consumer_infrastructure'
  | 'self_hosted'
  | 'unknown_host'
  | 'none';

export type SignupFacts = {
  /** The dominant classification of this domain's mail configuration. */
  class: SignupClass;
  provider?: string;
  /** The MX hostname that produced the classification. */
  matchedHost?: string;
  /**
   * Corroboration for the free-routing fingerprint.
   *
   * Three states, and the distinction carries a weight. `undefined` means no corroboration was
   * obtainable: either the matched provider publishes nothing to check against, or the network
   * prevented a check from completing. An empty array means every available check ran and none of them
   * agreed, which is the only state the scorer treats as weakening the match.
   */
  corroboration?: string[];
  /** True when MX points at the domain's own namespace. */
  selfHosted: boolean;
};

export type PricingFacts = {
  suffix: string;
  /** First-year registration price in USD. */
  registration?: number;
  renewal?: number;
  /** Renewal divided by registration. Above 1 means year one was discounted. */
  renewalRatio?: number;
  /**
   * True when this exact suffix is not sold by the price source, which happens for a restricted suffix and
   * for one sold only by registrars local to its registry. No price is inferred from the parent suffix.
   */
  unpriced?: boolean;
};

export type SiteFacts = {
  reachable: boolean;
  status?: number;
  finalUrl?: string;
  /** True when the final URL left the registrable domain. */
  redirectedOffDomain: boolean;
  redirectTarget?: {
    host: string;
    class: 'parking' | 'hosted_destination' | 'social_profile' | 'unknown';
    provider?: string;
  };
  title?: string;
  /** Visible text length after stripping markup, used for substantive-content detection. */
  contentLength?: number;
  substantive: boolean;
  parked: boolean;
  parkingEvidence?: string;
  /** True when the title or body contains the domain's own label. */
  titleMatchesDomain: boolean;
};

/**
 * Name-shape observations, computed locally with no network.
 *
 * Only the bulk-registration template survives. Character-histogram measures of the label were built and
 * then dropped, after the benchmark showed they could not separate a generated name from a chosen one;
 * see the note in `scoring/signals.ts`.
 */
export type NameFacts = {
  /** True for a word followed by 3 to 6 trailing digits, the bulk-registration template. */
  templateDigits: boolean;
};

export type RegistrarDefaultFacts = {
  provider: string;
  nameserver: string;
  forwardingMx: string;
};

export type DomainFacts = {
  meta: FactsMeta;
  registration?: RegistrationFacts;
  dns?: DnsFacts;
  mail?: MailFacts;
  signup?: SignupFacts;
  registrarDefault?: RegistrarDefaultFacts;
  pricing?: PricingFacts;
  site?: SiteFacts;
  name: NameFacts;
  /** Per-source status, so the UI can show what the score was and was not based on. */
  sources: SourceStatus[];
};

export type SourceStatus = {
  source: SourceId;
  status: CollectorStatus;
  reason?: string;
  elapsedMs: number;
  sourceUrl?: string;
};

export function toSourceStatus(result: CollectorResult<unknown>): SourceStatus {
  return {
    source: result.source,
    status: result.status,
    reason: result.reason,
    elapsedMs: result.elapsedMs,
    sourceUrl: result.sourceUrl,
  };
}

/**
 * The first-seen estimate, which comes from the registration record alone.
 *
 * Both registration protocols report a real creation date, so neither is an approximation and they are
 * not ranked against each other here. What is still deliberately absent is any *substitute* for a
 * registration record: where a registry publishes neither RDAP nor a creation date over WHOIS, the domain
 * yields no age rather than a lower bound inferred from certificates or archives, which is a weaker claim
 * than it looks and cost more latency than it was worth.
 */
export function firstSeen(facts: DomainFacts): { date: string; source: string } | null {
  const creation = facts.registration?.creation;
  if (!creation || !Number.isFinite(Date.parse(creation))) return null;
  return { date: creation, source: 'registration record' };
}

export function ageDays(facts: DomainFacts): number | null {
  const seen = firstSeen(facts);
  if (!seen) return null;
  const analysedAt = Date.parse(facts.meta.analysedAt);
  const ms = analysedAt - Date.parse(seen.date);
  return ms >= 0 ? Math.floor(ms / 86_400_000) : 0;
}

export function daysUntil(dateIso: string | undefined, from: string): number | null {
  if (!dateIso) return null;
  const target = Date.parse(dateIso);
  if (!Number.isFinite(target)) return null;
  return Math.floor((target - Date.parse(from)) / 86_400_000);
}
