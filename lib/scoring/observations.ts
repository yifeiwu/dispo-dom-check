import type { DomainFacts } from '../facts';

/**
 * Facts that are reported beside a verdict and deliberately move no score.
 *
 * These were signals until they were zeroed in 1.3.0, and they stayed in the signal registry for two
 * more versions carrying a `weight` of zero, a `dimension` whose arithmetic they never touched and a
 * `points: 0` the UI had to annotate so a reader would not mistake it for a heuristic that happened to
 * come out neutral. Declaring them here instead states the same thing in the type: an observation has
 * evidence and a rationale, and no way to express a score at all.
 *
 * The rule that put them here is unchanged, and it is the one thing to preserve if this list is edited.
 * A credit is paid only where somebody other than the domain confirms it. Every entry below is a string
 * the domain publishes in its own zone, checked against nobody, so all of it is free to mint and an
 * account farmer will mint it at scale. They are still collected and shown because each rides along in
 * a record fetched anyway, and because a reader can weigh what the score will not.
 *
 * Absence is never penalised here, exactly as it never was. An observation that does not apply simply
 * does not appear.
 */
export type ObservationDefinition = {
  id: string;
  /** Short human label for the fact itself. */
  label: string;
  /** Why this is collected, and why it earns nothing. Fixed text, never domain-specific. */
  rationale: string;
  /** What was actually seen for this domain, or `null` where there was nothing to report. */
  observe(facts: DomainFacts): { evidence: string; sourceUrl?: string } | null;
};

export type ObservationResult = {
  id: string;
  label: string;
  rationale: string;
  evidence: string;
  sourceUrl?: string;
};

function sourceUrlFor(facts: DomainFacts, source: string): string | undefined {
  return facts.sources.find((entry) => entry.source === source)?.sourceUrl;
}

export const OBSERVATIONS: ObservationDefinition[] = [
  {
    id: 'economics.unpriced_suffix',
    label: 'Suffix absent from the reference price list',
    rationale:
      'The price list is one registrar\u2019s catalogue, so it describes the mainstream retail market rather than every suffix in existence. Absence from it has two explanations that point in opposite directions: the suffix may not be openly registrable at all, which is a positive, or it may be sold only by registrars local to its registry, which is where the cheapest namespaces in existence live. Nothing distinguishes those two cases from a price list that does not carry the suffix, so this is reported for the reader and scores nothing.',
    observe(facts) {
      // Registration economics belong to the provider for a platform-issued name, not to this label.
      if (facts.meta.providerSuffix) return null;
      if (!facts.pricing?.unpriced) return null;
      // Accreditation already establishes that this suffix is not openly registrable, and says so with a
      // positive score. Repeating it as an open question would be worse than silence.
      if (facts.meta.vettedSuffix) return null;
      return {
        evidence: `No mainstream registrar publishes a price for the .${facts.pricing.suffix} suffix. It may not be openly registrable, or it may be sold only by registrars local to its registry, so its registration cost could not be established either way`,
        sourceUrl: sourceUrlFor(facts, 'pricing'),
      };
    },
  },
  {
    id: 'mail.spf_present',
    label: 'SPF published',
    rationale:
      'An SPF record shows someone thought about how this domain sends mail, and it is near-universal among senders. It scores nothing because it is a TXT record the domain writes about itself, with no cost and nothing corroborating it. Reported because a reader wants to see it; absence is not penalised either.',
    observe(facts) {
      if (!facts.mail?.spf) return null;
      return {
        evidence: 'An SPF policy is published',
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.dmarc_policy',
    label: 'DMARC policy',
    rationale:
      'DMARC presence stopped discriminating once bulk-sender rules pushed everyone to publish it, and abusers set the strictest policy precisely because it is free and looks reputable. That argument was always in the model and the weight contradicted it, so the policy now scores nothing in either direction and is reported as a fact.',
    observe(facts) {
      const policy = facts.mail?.dmarcPolicy;
      if (!policy) return null;
      return {
        evidence: `DMARC published with p=${policy}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.strict_alignment',
    label: 'DMARC strict alignment',
    rationale:
      'Strict alignment breaks mail that has not been deliberately configured, so publishing it was read as evidence that someone tested their sending. It scores nothing because that inference cannot be checked: adding two characters to a DMARC record is free whether or not any mail was ever sent, and a domain that never sends breaks nothing by requiring it.',
    observe(facts) {
      if (!facts.mail?.dmarcStrictAlignment) return null;
      return {
        evidence: 'DMARC requires strict alignment',
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.subdomain_policy',
    label: 'Explicit DMARC subdomain policy',
    rationale:
      'Setting a separate subdomain policy was read as a detail only an operator thinking about their whole namespace would bother with. It scores nothing: it is one more tag in a record the domain writes about itself, and it costs a throwaway domain nothing to include.',
    observe(facts) {
      if (!facts.mail?.dmarcSubdomainPolicy) return null;
      return {
        evidence: `DMARC sets an explicit subdomain policy of sp=${facts.mail.dmarcSubdomainPolicy}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.paid_spf_senders',
    label: 'SPF authorises paid sending platforms',
    rationale:
      'Naming commercial sending platforms in SPF was read as evidence that someone pays per message to send from this domain. It scores nothing because the record proves no such relationship: an SPF include is a string, the platform is not consulted, and authorising a sender you have no account with costs nothing and breaks nothing.',
    observe(facts) {
      const vendors = facts.mail?.spfPaidSenders ?? [];
      if (vendors.length === 0) return null;
      return {
        evidence: `SPF authorises ${vendors.join(', ')}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'footprint.saas_vendors',
    label: 'Distinct SaaS vendors verified against this domain',
    rationale:
      'Each verification record was read as the residue of someone completing a domain-verification step inside a paid product, which made the count of distinct vendors a proxy for organisational spend. The residue is indistinguishable from the thing itself: the census matches a TXT prefix, no vendor publishes any way to confirm a token it issued, and invented strings count the same as real ones. It scores nothing and is reported, since a reader can weigh the named vendors themselves.',
    observe(facts) {
      const vendors = facts.mail?.saasVendors ?? [];
      if (vendors.length === 0) return null;
      return {
        evidence: `${vendors.length} distinct vendors verified: ${vendors.slice(0, 8).join(', ')}${vendors.length > 8 ? ', and others' : ''}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'footprint.dkim',
    label: 'DKIM signing keys published',
    rationale:
      'Published signing keys were read as evidence that mail from this domain is actually signed, which requires configuration on the sending platform as well as in DNS. Only the DNS half is observable, and that half is free: generating a keypair and publishing the public half is one command, and nothing here verifies that any message was ever signed with it. It scores nothing. Selectors cannot be enumerated, so finding none proves nothing either.',
    observe(facts) {
      const selectors = facts.mail?.dkimSelectors ?? [];
      if (selectors.length === 0) return null;
      return {
        evidence: `DKIM keys published at ${selectors.length} known selector${selectors.length === 1 ? '' : 's'}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
];

export function observe(facts: DomainFacts): ObservationResult[] {
  const results: ObservationResult[] = [];

  for (const definition of OBSERVATIONS) {
    const outcome = definition.observe(facts);
    if (!outcome) continue;
    results.push({
      id: definition.id,
      label: definition.label,
      rationale: definition.rationale,
      evidence: outcome.evidence,
      sourceUrl: outcome.sourceUrl,
    });
  }

  return results;
}
