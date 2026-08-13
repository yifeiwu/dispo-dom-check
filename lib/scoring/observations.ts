import type { DomainFacts } from '../facts';
import { describeVmcFailure } from '../data/bimi-authorities';

/**
 * Facts that are reported beside a verdict and deliberately move no score.
 *
 * These were signals until they were zeroed in 1.3.0, and they stayed in the signal registry for two
 * more versions carrying a `weight` of zero, a `dimension` whose arithmetic they never touched and a
 * `points: 0` the UI had to annotate so a reader would not mistake it for a heuristic that happened to
 * come out neutral. Declaring them here instead states the same thing in the type: an observation has
 * evidence and a rationale, and no way to express a score at all.
 *
 * Two different findings can land an entry here, and conflating them would lose the more useful one.
 *
 * Most of this list failed the verification rule: a credit is paid only where somebody other than the
 * domain confirms it, and these are strings the domain publishes in its own zone, checked against
 * nobody, so all of it is free to mint and an account farmer will mint it at scale. Nothing about that
 * depends on a measurement, and no future collection can overturn it.
 *
 * `footprint.dnssec` is here for the opposite reason and is the only entry that is. It passes the
 * verification rule outright — the resolver validated the chain to the root, which the domain cannot
 * assert its way past — and it was demoted in 1.5.0 because it was *measured and found flat*. That is a
 * statement about this population and a better collection could reverse it, which is exactly why it is
 * worth keeping the two cases apart.
 *
 * What both share is the reason they are still collected and shown: each rides along in a record
 * fetched anyway, so reporting it costs nothing, and a reader can weigh what the score will not.
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
  {
    id: 'mail.bimi_unverified',
    label: 'BIMI record without a verified certificate',
    rationale:
      'The domain publishes a BIMI record, which asks mailbox providers to display its logo beside its messages, but the Verified Mark Certificate that is supposed to stand behind it did not verify — it was missing, unreachable, expired, issued to a different domain, or signed by a key no Mark Verifying Authority is known to use. Publishing the record costs nothing and proves nothing; the certificate is the part that requires a registered trademark and about a thousand dollars a year. This is reported rather than penalised because a broken certificate is far more often neglect than deceit, and because a credit paid for the record alone is the exact defect that removed this signal in 1.3.0.',
    observe(facts) {
      const bimi = facts.mail?.bimi;
      if (!bimi?.record || bimi.verified) return null;
      return {
        evidence: `The mark could not be verified: ${describeVmcFailure(bimi.failure, bimi.failureDetail)}`,
        sourceUrl: bimi.certificateUrl,
      };
    },
  },
  {
    id: 'site.platform_served',
    label: 'Response looks like a website platform',
    rationale:
      'The page carried the markers of a hosted website platform, but the domain does not resolve into address space that platform publishes for custom domains, so only half of the confirmation is present. Response headers are whatever a server chooses to send and an asset reference in the page can be a site merely linking to a platform rather than living on one, which is the half a domain can arrange by itself. It is reported because it is usually true and costs nothing to notice, and it scores nothing because the part that would make it evidence is missing. Several platforms front their edge with a general-purpose CDN and so can never reach the scored tier at all.',
    observe(facts) {
      const platform = facts.site?.platform;
      if (!platform) return null;
      // Silent where the signal already paid, or it would report the same fact twice on one domain.
      if (platform.confirmation === 'served_and_addressed' && platform.paidCustomDomain) return null;
      const because = platform.paidCustomDomain
        ? 'the domain does not resolve into its published address space'
        : 'the platform is also self-hostable, so its markers do not imply a paid account';
      return {
        evidence: `${platform.provider} markers present (${platform.matchedOn}), but ${because}`,
        sourceUrl: facts.site?.finalUrl,
      };
    },
  },
  {
    id: 'footprint.dnssec',
    label: 'DNSSEC validated',
    rationale:
      'DNSSEC is fiddly to run and easy to break, so enabling it was read as indicating an operator who cares about correctness, and it earned +3 until 1.5.0. It is the one fact here that never had a verification problem: the resolver validated the chain to the root cryptographically, so this is somebody else\u2019s arithmetic rather than the domain\u2019s own claim. It stopped scoring because it turns out to describe the registrar rather than the registrant. Counted by domain it appears on 16% of the abuse holdout against 6% of the legitimate one, and the suffixes carrying it are the cheap bulk namespaces whose registrars enable it by default — 47% of .cfd and 39% of .id domains are signed, against 4% of .com. It is reported because it is true and costs nothing to observe, and because a reader may weigh it differently once they know whose decision it was.',
    observe(facts) {
      if (!facts.dns?.dnssecValidated) return null;
      return {
        evidence: 'The resolver validated this zone with DNSSEC',
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
