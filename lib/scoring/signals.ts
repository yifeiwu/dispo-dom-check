import { ageDays, daysUntil, type DomainFacts, type NameFacts } from '../facts';
import type { Dimension, ScoringConfig } from './weights';

/**
 * Signals are declared as data rather than written as branching code, and each definition carries its
 * own explanation. That is what makes the output readable and the model auditable: the UI and
 * `GET /api/model` render from this registry, so the explanation a user reads is the same object the
 * scorer evaluated.
 *
 * The distinction that makes a result row legible is between `rationale`, a fixed statement of why the
 * heuristic exists at all, and `evidence`, what was actually observed for this domain. Returning `null`
 * means the signal did not apply, which is different from scoring zero and is rendered differently.
 */
/**
 * What a heuristic can contribute, which is a range rather than a number for every tiered signal.
 *
 * `min` equals `max` where the heuristic has a single weight. Both are read from the config, so a
 * retuned weight moves the declared range with it.
 */
export type WeightRange = {
  min: number;
  max: number;
  /** How the range is reached, where the two bounds do not say it on their own. */
  note?: string;
};

const fixed = (points: number): WeightRange => ({ min: points, max: points });

const spanning = (points: readonly number[], note?: string): WeightRange => ({
  min: Math.min(...points),
  max: Math.max(...points),
  note,
});

export type SignalDefinition = {
  id: string;
  dimension: Dimension;
  /** Short human label for the heuristic itself. */
  label: string;
  /** Why this heuristic exists. Fixed text, never domain-specific. */
  rationale: string;
  /**
   * What this heuristic is worth, read from the same config keys `evaluate` reads.
   *
   * Declared beside `evaluate` rather than inferred from it, because one evaluation returns the points
   * for one domain and the question a reader of `/how-it-works` is asking is what the heuristic is worth
   * at all. A test scores every fixture and asserts each answer lands inside the declared range, so the
   * two cannot drift apart in silence.
   */
  weight(cfg: ScoringConfig): WeightRange;
  evaluate(
    facts: DomainFacts,
    cfg: ScoringConfig,
  ): { points: number; evidence: string; sourceUrl?: string } | null;
};

export type SignalResult = {
  id: string;
  dimension: Dimension;
  label: string;
  rationale: string;
  points: number;
  evidence: string;
  sourceUrl?: string;
};

/**
 * Registration-derived signals are meaningless for a platform-issued name, because the age, price and
 * registrar all belong to the provider. Suppressing them is more honest than scoring the provider's
 * decade of history as if it belonged to a subdomain created this morning.
 */
function registrationApplies(facts: DomainFacts): boolean {
  return !facts.meta.providerSuffix;
}

function sourceUrlFor(facts: DomainFacts, source: string): string | undefined {
  return facts.sources.find((entry) => entry.source === source)?.sourceUrl;
}

/**
 * The registration record can arrive over either protocol, so the evidence link follows whichever one
 * answered rather than naming RDAP and being wrong for every ccTLD that has none.
 */
function registrationSourceUrl(facts: DomainFacts): string | undefined {
  return facts.registration ? sourceUrlFor(facts, facts.registration.via) : undefined;
}

/**
 * The record classes breadth is counted over, as a list rather than a chain of conditions.
 *
 * Written this way so the most the credit can pay is derived from the list itself. Restating the count
 * in the declared weight would be a second place to update when a class is added, and the version that
 * drifts is always the one nobody scores against.
 *
 * The list holds only classes whose presence is established by something resolving, rather than by the
 * domain saying so. Four were dropped in 1.3.0 — SPF, DKIM, vendor verification and business service —
 * because each is a TXT or CNAME record with arbitrary contents that nothing checks, and because the
 * last three were simultaneously earning their own credits in `footprint`. That let one set of invented
 * records clear two dimension clamps, which is the exact accumulation the clamps exist to stop.
 *
 * What is left still measures effort rather than spend, which is all this signal ever claimed: a name
 * that resolves, a conventional `www`, a mail host and an MX are each a delegation somebody had to
 * point at a host that answers.
 */
const RECORD_CLASSES: readonly { label: string; present(facts: DomainFacts): boolean }[] = [
  {
    label: 'web host',
    present: (facts) => (facts.dns?.a.length ?? 0) > 0 || (facts.dns?.aaaa.length ?? 0) > 0,
  },
  { label: 'www', present: (facts) => Boolean(facts.dns?.wwwExists) },
  { label: 'mail host', present: (facts) => Boolean(facts.dns?.mailHostExists) },
  { label: 'MX', present: (facts) => (facts.dns?.mx.length ?? 0) > 0 },
];

export const SIGNALS: readonly SignalDefinition[] = [
  // ---------------------------------------------------------------------------------------------
  // Signup capability: the primary dimension.
  // ---------------------------------------------------------------------------------------------
  {
    id: 'signup.temp_mail',
    dimension: 'signup',
    label: 'Mail handled by a throwaway-inbox service',
    rationale:
      'A domain whose mail exchangers belong to a temp-mail service exists to hand out disposable addresses. This is the closest thing to conclusive evidence of signup abuse the model can obtain without a reputation feed, because no legitimate organisation routes its mail to a throwaway-inbox provider.',
    weight: (cfg) => fixed(cfg.signup.tempMail),
    evaluate(facts, cfg) {
      if (facts.signup?.class !== 'temp_mail') return null;
      return {
        points: cfg.signup.tempMail,
        evidence: `Mail exchanger ${facts.signup.matchedHost} belongs to ${facts.signup.provider}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'signup.free_routing',
    dimension: 'signup',
    label: 'Free unlimited-alias mail routing on a custom domain',
    rationale:
      'Free custom-domain routing gives catch-all delivery and unlimited aliases at zero marginal cost, which is exactly the capability mass account creation requires. Hobbyists and privacy-minded individuals use these services on domains they have held for years, so on its own this is only a moderate signal. What makes it decisive is the conjunction with youth and an absent website, and most of the weight is held there rather than here.',
    weight: (cfg) => fixed(cfg.signup.freeRouting),
    /*
     * Corroboration is reported as evidence and deliberately not scored.
     *
     * The tri-state exists so the collector can distinguish a provider it cannot check from one it
     * checked and disagreed with, but the second state does not occur: across 449 checkable matches in
     * the holdout, spanning all four labels, every one corroborated. The dominant provider's setup
     * wizard writes its SPF include at the same moment as the MX record, so corroboration re-detects the
     * same act of configuration rather than measuring anything independent of it. A weight here would
     * never vary.
     */
    evaluate(facts, cfg) {
      if (facts.signup?.class !== 'free_routing') return null;
      const corroboration =
        facts.signup.corroboration && facts.signup.corroboration.length > 0
          ? `. Corroborated: ${facts.signup.corroboration.join('; ')}`
          : '';
      return {
        points: cfg.signup.freeRouting,
        evidence: `Mail routed through ${facts.signup.provider} via ${facts.signup.matchedHost}${corroboration}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'signup.forwarder',
    dimension: 'signup',
    label: 'Mail handled by an alias forwarding service',
    rationale:
      'Alias forwarders issue unlimited addresses that land in one mailbox, which is ideal for multi-account creation but is also a legitimate privacy practice. This is surfaced as a flag for the consumer to apply their own policy to, rather than treated as evidence of abuse.',
    weight: (cfg) => fixed(cfg.signup.forwarder),
    evaluate(facts, cfg) {
      if (facts.signup?.class !== 'forwarder') return null;
      return {
        points: cfg.signup.forwarder,
        evidence: `Mail exchanger ${facts.signup.matchedHost} belongs to ${facts.signup.provider}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  /*
   * There is deliberately no penalty for a shared alias-relay domain.
   *
   * It scored -12 until the audit measured it across the whole holdout, where it fired on 12 families,
   * none of them abuse, and carried a negative separation: as a scoring signal it only ever cost
   * legitimate domains points. That is the model's stated policy on forwarders contradicting itself in
   * code — the position is that alias capability is flagged for the consumer rather than condemned, and
   * a penalty is condemnation. The `forwarder` flag is derived from `facts.meta.relayDomain` directly,
   * so it survives the signal's removal unchanged. See `docs/SCORING.md`.
   */
  {
    id: 'signup.paid_tenant',
    dimension: 'signup',
    label: 'Mail hosted on a paid business mail tenant',
    rationale:
      'Per-seat business mail costs money for every mailbox, which is the opposite of the economics an account farm needs. The bonus is small because the major suites offer trials and cheap entry tiers that an abuser can reach.',
    weight: (cfg) => fixed(cfg.signup.paidTenant),
    evaluate(facts, cfg) {
      const tenantSuffix = facts.meta.providerSuffix?.impliesPaidTenant;
      if (facts.signup?.class !== 'paid_tenant' && !tenantSuffix) return null;
      return {
        points: cfg.signup.paidTenant,
        evidence: tenantSuffix
          ? `Name issued under a ${facts.meta.providerSuffix?.provider}, which requires a paid subscription`
          : `Mail hosted on ${facts.signup?.provider}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Registration economics.
  // ---------------------------------------------------------------------------------------------
  {
    id: 'economics.first_year_price',
    dimension: 'economics',
    label: 'First-year registration price of the suffix',
    rationale:
      'Bulk abuse is a unit-cost problem. At the bottom of the price range an operator buys seven domains for the price of one mainstream registration, so a very cheap suffix lowers the cost of disposing of a domain after a single use. The figure is the suffix\u2019s list price, not what this particular name sold for: a premium or resold name can cost far more, and paying more than list is not evidence of abuse.',
    weight: (cfg) => spanning(cfg.economics.priceTiers.map((tier) => tier.points), 'by price tier'),
    evaluate(facts, cfg) {
      if (!registrationApplies(facts)) return null;
      const price = facts.pricing?.registration;
      if (price === undefined) return null;
      const suffix = facts.pricing?.suffix;
      const tier = cfg.economics.priceTiers.find((entry) => price < entry.under);
      if (!tier || tier.points === 0) {
        return {
          points: 0,
          evidence: `A first-year registration under .${suffix} lists at about $${price.toFixed(2)}, which is mainstream pricing`,
          sourceUrl: sourceUrlFor(facts, 'pricing'),
        };
      }
      return {
        points: tier.points,
        evidence: `A first-year registration under .${suffix} lists at about $${price.toFixed(2)}`,
        sourceUrl: sourceUrlFor(facts, 'pricing'),
      };
    },
  },
  {
    id: 'economics.renewal_ratio',
    dimension: 'economics',
    label: 'Renewal price far above first-year price',
    rationale:
      'An abuser only ever pays the first year, so a registry discounting year one by a large factor is selling disposability. This is scored only while the domain is inside its first term, because a renewed domain has already paid the real price and the discount no longer describes it.',
    weight: (cfg) =>
      spanning(
        [cfg.economics.renewalRatioHigh.points, cfg.economics.renewalRatioModerate.points],
        'by discount depth',
      ),
    evaluate(facts, cfg) {
      if (!registrationApplies(facts)) return null;
      const ratio = facts.pricing?.renewalRatio;
      if (ratio === undefined) return null;

      // Only meaningful inside the first term. Without an age we cannot establish that, so stay silent.
      const age = ageDays(facts);
      const term = facts.registration?.termYears;
      const insideFirstTerm = age !== null && term !== undefined ? age <= term * 366 : age !== null && age < 366;
      if (!insideFirstTerm) return null;

      if (ratio >= cfg.economics.renewalRatioHigh.threshold) {
        return {
          points: cfg.economics.renewalRatioHigh.points,
          evidence: `Renewal costs about ${ratio.toFixed(1)}x the first-year price, and the domain is still inside its first term`,
          sourceUrl: sourceUrlFor(facts, 'pricing'),
        };
      }
      if (ratio >= cfg.economics.renewalRatioModerate.threshold) {
        return {
          points: cfg.economics.renewalRatioModerate.points,
          evidence: `Renewal costs about ${ratio.toFixed(1)}x the first-year price, and the domain is still inside its first term`,
          sourceUrl: sourceUrlFor(facts, 'pricing'),
        };
      }
      return null;
    },
  },
  {
    id: 'economics.unpriced_suffix',
    dimension: 'economics',
    label: 'Suffix absent from the reference price list',
    rationale:
      'The price list is one registrar\u2019s catalogue, so it describes the mainstream retail market rather than every suffix in existence. Absence from it has two explanations that point in opposite directions: the suffix may not be openly registrable at all, which is a positive, or it may be sold only by registrars local to its registry, which is where the cheapest namespaces in existence live. Nothing distinguishes those two cases from a price list that does not carry the suffix, so this is reported for the reader and deliberately scores zero.',
    weight: (cfg) => fixed(cfg.economics.unpricedSuffix),
    evaluate(facts, cfg) {
      if (!registrationApplies(facts)) return null;
      if (!facts.pricing?.unpriced) return null;
      // Accreditation already establishes that this suffix is not openly registrable, and says so with a
      // positive score. Repeating it as an open question would be worse than silence.
      if (facts.meta.vettedSuffix) return null;
      return {
        points: cfg.economics.unpricedSuffix,
        evidence: `No mainstream registrar publishes a price for the .${facts.pricing.suffix} suffix. It may not be openly registrable, or it may be sold only by registrars local to its registry, so its registration cost could not be established either way`,
        sourceUrl: sourceUrlFor(facts, 'pricing'),
      };
    },
  },
  /*
   * There is deliberately no standalone penalty for a free subdomain, and no second credit for a vetted
   * suffix in this dimension.
   *
   * The free-subdomain penalty was -12 and measured flat: 46 families, a lift interval spanning 1.00, and
   * no verdict anywhere that changed when it was removed. The reasoning behind it survives in
   * `combo.farm_profile`, which still reads the free-subdomain fact directly, and in the `free_subdomain`
   * flag, which is derived from the facts rather than from this signal.
   *
   * The vetted-suffix credit was +4 here and +15 in the name dimension, evaluating the identical
   * predicate. Splitting one fact across two dimensions defeated both clamps, which is exactly the
   * accumulation the clamps exist to stop, and the audit found the two firing on the same domains at 100%
   * agreement. The credit is now paid once, in `name.vetted_suffix`. See `docs/SCORING.md`.
   */

  // ---------------------------------------------------------------------------------------------
  // Age and registration.
  // ---------------------------------------------------------------------------------------------
  {
    id: 'age.first_seen',
    dimension: 'age',
    label: 'Age of the domain',
    rationale:
      'Age is the anchor signal, because a domain that has existed for years has survived the abuse lifecycle: farm domains are used and abandoned quickly. It comes from the registration record alone, read over RDAP where the registry publishes one and over WHOIS where it does not. A registry that publishes neither yields no age at all rather than an approximation.',
    weight: (cfg) => spanning(cfg.age.tiers.map((tier) => tier.points), 'by age'),
    evaluate(facts, cfg) {
      const age = ageDays(facts);
      if (age === null) return null;
      const tier = cfg.age.tiers.find((entry) => age < entry.underDays);
      if (!tier) return null;

      const years = age / 365;
      const readable = age < 60 ? `${age} days old` : `about ${years.toFixed(1)} years old`;
      return {
        points: tier.points,
        evidence: `First seen ${readable}`,
        sourceUrl: registrationSourceUrl(facts),
      };
    },
  },
  /*
   * There is deliberately no credit for a registration paid years ahead.
   *
   * It paid +5 for three or more years of remaining term, on the reasoning that an operator planning to
   * discard a domain has no reason to buy that far forward. The holdout disagrees: it fired on 41
   * families, and removing it took ten abuse domains out of a legitimate band while costing no
   * legitimate domain a verdict. Bulk registrars sell multi-year terms at a discount, so paying ahead
   * turns out to be as available to someone buying a hundred names as to someone buying one, and the
   * commitment the signal claimed to measure is not the commitment it was reading.
   */
  {
    id: 'age.single_year_term',
    dimension: 'age',
    label: 'Registered for the minimum one-year term',
    rationale:
      'The minimum term is the cheapest way to hold a domain and the default for a single-use registration. It is weak on its own, since most legitimate registrations are also annual, and it is only observable while the domain is inside its first period.',
    weight: (cfg) => fixed(cfg.age.singleYearTerm),
    evaluate(facts, cfg) {
      if (!registrationApplies(facts)) return null;
      const term = facts.registration?.termYears;
      if (term === undefined || term > 1.2) return null;
      return {
        points: cfg.age.singleYearTerm,
        evidence: 'Registered for a single-year term',
        sourceUrl: registrationSourceUrl(facts),
      };
    },
  },
  {
    id: 'age.expiring_unrenewed',
    dimension: 'age',
    label: 'Inside its first term and about to expire unrenewed',
    rationale:
      'A domain in its first term, days from expiry and never renewed, is about to be dropped. That is the economic signature of a registration bought for one purpose and abandoned.',
    weight: (cfg) => fixed(cfg.age.expiringUnrenewed.points),
    evaluate(facts, cfg) {
      if (!registrationApplies(facts)) return null;
      const age = ageDays(facts);
      const until = daysUntil(facts.registration?.expiry, facts.meta.analysedAt);
      const term = facts.registration?.termYears;
      if (age === null || until === null || term === undefined) return null;
      if (term > 1.2 || age > 366) return null;
      if (until < 0 || until > cfg.age.expiringUnrenewed.withinDays) return null;
      return {
        points: cfg.age.expiringUnrenewed.points,
        evidence: `Expires in ${until} days, still inside its first registration term`,
        sourceUrl: registrationSourceUrl(facts),
      };
    },
  },
  /*
   * There is deliberately no standalone "recently changed registration" signal.
   *
   * RDAP's `last changed` event fires on any modification at all, including a nameserver edit or a
   * contact refresh, so it cannot distinguish a change of ownership from routine maintenance. Testing it
   * against well-run domains showed it penalising them for being actively maintained, which is the
   * opposite of what it was meant to detect. Separating the two needs an independent history to compare
   * against, and no source in the model provides one.
   */
  {
    id: 'age.registry_hold',
    dimension: 'age',
    label: 'Suspended by the registry',
    rationale:
      'A registry or registrar hold means the domain has already been suspended, usually for abuse or a contractual failure. It is the one near-conclusive negative available from the registration record.',
    weight: (cfg) => fixed(cfg.age.registryHold),
    evaluate(facts, cfg) {
      const statuses = facts.registration?.statuses ?? [];
      const hold = statuses.find((status) => status === 'serverhold' || status === 'clienthold');
      if (!hold) return null;
      return {
        points: cfg.age.registryHold,
        evidence: `Registration carries the ${hold} status`,
        sourceUrl: registrationSourceUrl(facts),
      };
    },
  },
  {
    id: 'age.pending_delete',
    dimension: 'age',
    label: 'Pending deletion or in redemption',
    rationale:
      'A domain in the deletion or redemption lifecycle has lapsed. Whatever it was used for is ending, and it may be about to change hands entirely.',
    weight: (cfg) => fixed(cfg.age.pendingDelete),
    evaluate(facts, cfg) {
      const statuses = facts.registration?.statuses ?? [];
      const status = statuses.find((entry) => entry === 'pendingdelete' || entry === 'redemptionperiod');
      if (!status) return null;
      return {
        points: cfg.age.pendingDelete,
        evidence: `Registration carries the ${status} status`,
        sourceUrl: registrationSourceUrl(facts),
      };
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Mail posture: depth rather than presence.
  // ---------------------------------------------------------------------------------------------
  /*
   * There is deliberately no signal for the mere presence of MX records.
   *
   * It used to pay a small positive for configured mail, on the reasoning that setup is a deliberate act.
   * The threat model says otherwise: an account farmer has to receive the verification message, so
   * working inbound mail is a precondition of the abuse rather than evidence against it, and crediting it
   * scores the wrong direction on the one capability every farm domain must have. See `docs/SCORING.md`.
   *
   * Absence is still never penalised either. Whether a domain can receive mail remains a *fact* the model
   * reads — the two conjunctions below both require it, and `configuration.mail_only_zone` penalises mail
   * with nothing beside it — but it earns no points in either direction on its own.
   */
  /*
   * The credits below all score zero, and each is kept rather than deleted because it remains a fact
   * worth showing next to a verdict.
   *
   * They were withdrawn together in 1.3.0 under one rule: a credit is paid only where somebody other
   * than the domain confirms it. Every one of these is a string the domain publishes in its own zone,
   * and nothing in the model checked any of them against the party they name. That made the whole
   * group free to assert, and free to assert is the one thing the threat model says an account farmer
   * will do at scale — the dimension was measuring what an operator was willing to type.
   *
   * Absence was never penalised here and still is not. The change is that presence no longer pays,
   * which leaves the affirmative misconfigurations as the only signals in the dimension that move a
   * score. See `docs/SCORING.md`.
   */
  {
    id: 'mail.spf_present',
    dimension: 'mail',
    label: 'SPF published',
    rationale:
      'An SPF record shows someone thought about how this domain sends mail, and it is near-universal among senders. It scores nothing because it is a TXT record the domain writes about itself, with no cost and nothing corroborating it. Reported because a reader wants to see it; absence is not penalised either.',
    weight: (cfg) => fixed(cfg.mail.spfPresent),
    evaluate(facts, cfg) {
      if (!facts.mail?.spf) return null;
      return {
        points: cfg.mail.spfPresent,
        evidence: 'An SPF policy is published',
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.dmarc_policy',
    dimension: 'mail',
    label: 'DMARC policy',
    rationale:
      'DMARC presence stopped discriminating once bulk-sender rules pushed everyone to publish it, and abusers set the strictest policy precisely because it is free and looks reputable. That argument was always in the model and the weight contradicted it, so the policy now scores nothing in either direction and is reported as a fact.',
    weight: (cfg) =>
      spanning([cfg.mail.dmarcMonitorOnly, cfg.mail.dmarcEnforcing], 'by how strict the policy is'),
    evaluate(facts, cfg) {
      const policy = facts.mail?.dmarcPolicy;
      if (!policy) return null;
      const enforcing = policy === 'reject' || policy === 'quarantine';
      return {
        points: enforcing ? cfg.mail.dmarcEnforcing : cfg.mail.dmarcMonitorOnly,
        evidence: `DMARC published with p=${policy}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.strict_alignment',
    dimension: 'mail',
    label: 'DMARC strict alignment',
    rationale:
      'Strict alignment breaks mail that has not been deliberately configured, so publishing it was read as evidence that someone tested their sending. It scores nothing because that inference cannot be checked: adding two characters to a DMARC record is free whether or not any mail was ever sent, and a domain that never sends breaks nothing by requiring it.',
    weight: (cfg) => fixed(cfg.mail.strictAlignment),
    evaluate(facts, cfg) {
      if (!facts.mail?.dmarcStrictAlignment) return null;
      return {
        points: cfg.mail.strictAlignment,
        evidence: 'DMARC requires strict alignment',
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.subdomain_policy',
    dimension: 'mail',
    label: 'Explicit DMARC subdomain policy',
    rationale:
      'Setting a separate subdomain policy was read as a detail only an operator thinking about their whole namespace would bother with. It scores nothing: it is one more tag in a record the domain writes about itself, and it costs a throwaway domain nothing to include.',
    weight: (cfg) => fixed(cfg.mail.explicitSubdomainPolicy),
    evaluate(facts, cfg) {
      if (!facts.mail?.dmarcSubdomainPolicy) return null;
      return {
        points: cfg.mail.explicitSubdomainPolicy,
        evidence: `DMARC sets an explicit subdomain policy of sp=${facts.mail.dmarcSubdomainPolicy}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.commercial_rua',
    dimension: 'mail',
    label: 'DMARC reports sent to a confirmed commercial vendor',
    rationale:
      'Paying a vendor to process aggregate reports means an organisation actively runs a mail programme. Naming one costs nothing, so the credit is paid only where the vendor confirms the domain: RFC 7489 requires an external report destination to authorise the sender in its own zone, and only the vendor can publish that record. A vendor that has not vouched for the domain earns nothing, and a check the resolver could not complete earns nothing either, since silence is not a refusal. Absence is never a penalty, because sophisticated operators frequently self-host reporting.',
    weight: (cfg) => fixed(cfg.mail.commercialRua),
    evaluate(facts, cfg) {
      const vendor = facts.mail?.dmarcRuaCommercialVendor;
      if (!vendor) return null;
      if (facts.mail?.dmarcRuaVerified !== true) {
        return {
          points: 0,
          evidence: `Aggregate reports are addressed to ${vendor}, which has not published the record authorising this domain to report to it, so the arrangement could not be confirmed`,
          sourceUrl: sourceUrlFor(facts, 'dns'),
        };
      }
      return {
        points: cfg.mail.commercialRua,
        evidence: `${vendor} publishes the record authorising this domain to send aggregate reports to it`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.paid_spf_senders',
    dimension: 'mail',
    label: 'SPF authorises paid sending platforms',
    rationale:
      'Naming commercial sending platforms in SPF was read as evidence that someone pays per message to send from this domain. It scores nothing because the record proves no such relationship: an SPF include is a string, the platform is not consulted, and authorising a sender you have no account with costs nothing and breaks nothing.',
    weight: (cfg) => fixed(cfg.mail.paidSpfSenders),
    evaluate(facts, cfg) {
      const vendors = facts.mail?.spfPaidSenders ?? [];
      if (vendors.length === 0) return null;
      return {
        points: cfg.mail.paidSpfSenders,
        evidence: `SPF authorises ${vendors.join(', ')}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.spf_permit_all',
    dimension: 'mail',
    label: 'SPF authorises the entire internet',
    rationale:
      'An SPF record ending in a permissive catch-all authorises anyone to send as this domain. No competent operator publishes that, so unlike a missing record it is affirmative evidence of carelessness.',
    weight: (cfg) => fixed(cfg.mail.spfPermitAll),
    evaluate(facts, cfg) {
      if (facts.mail?.spfAllQualifier !== '+all') return null;
      return {
        points: cfg.mail.spfPermitAll,
        evidence: 'SPF ends in +all, authorising any host to send as this domain',
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'mail.no_spf_with_site',
    dimension: 'mail',
    label: 'Mail and a live site but no SPF at all',
    rationale:
      'A domain running both mail and a website with no sending policy at all is unusual enough to note. The pairing is what matters: a missing SPF record on its own is never penalised.',
    weight: (cfg) => fixed(cfg.mail.liveSiteWithoutSpf),
    evaluate(facts, cfg) {
      if (!facts.dns || facts.dns.mx.length === 0) return null;
      if (!facts.site?.substantive) return null;
      if (facts.mail?.spf) return null;
      return {
        points: cfg.mail.liveSiteWithoutSpf,
        evidence: 'Mail and a live site are configured but no SPF policy is published',
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  /*
   * There is deliberately no credit for a BIMI record.
   *
   * At +8 it was the strongest positive in the dimension, on the reasoning that displaying a BIMI logo
   * requires a Verified Mark Certificate bought against a registered trademark. Publishing the record
   * requires none of that. What was checked was that a TXT record began with `v=BIMI1`, never that the
   * certificate it points at exists, so the credit priced a purchase and measured a string.
   *
   * Confirming it properly means fetching the certificate and checking its issuer, which is a second
   * network request for a signal that fired on 2 of 4,691 holdout domains — too rare to calibrate even
   * if it were sound. So this removal retires the probe as well: `lib/collect/mail.ts` no longer queries
   * `default._bimi`, which is one fewer round trip on every analysis.
   */

  // ---------------------------------------------------------------------------------------------
  // Configuration effort.
  // ---------------------------------------------------------------------------------------------
  {
    id: 'configuration.record_breadth',
    dimension: 'configuration',
    label: 'Breadth of configured DNS records',
    rationale:
      'A zone accumulates records as a real organisation uses it: a name that resolves, a conventional www, a mail host, mail exchangers. Breadth is the best available proxy for a human having set this domain up for a purpose beyond receiving mail. Only records that point at a host are counted, since a zone can be filled with TXT records saying anything at no cost.',
    weight: (cfg) =>
      spanning(
        [
          cfg.configuration.mailOnlyZone,
          RECORD_CLASSES.length * cfg.configuration.recordBreadthPerClass,
        ],
        `${cfg.configuration.recordBreadthPerClass} per record class, and ${cfg.configuration.mailOnlyZone} for mail and nothing else`,
      ),
    evaluate(facts, cfg) {
      if (!facts.dns) return null;
      const classes = RECORD_CLASSES.filter((entry) => entry.present(facts)).map(
        (entry) => entry.label,
      );

      /*
       * Mail and nothing else describes a domain that exists only to receive.
       *
       * Tested against the non-mail classes by name rather than by counting how many of the credit's
       * classes were present, which coupled the penalty to the credit: trimming the class list in
       * 1.3.0 silently widened this penalty onto every domain whose only other record was an SPF
       * string, which is an ordinary mail-only setup rather than a farm.
       *
       * Reading it this way is also the more robust direction. The classes named here are delegations
       * that have to point at a host, so escaping the penalty means standing something up, where a
       * count over the old list could be escaped with a TXT record saying anything at all.
       */
      const nonMailClasses = ['web host', 'www'];
      const mailOnly =
        facts.dns.mx.length > 0 && !classes.some((label) => nonMailClasses.includes(label));
      if (mailOnly) {
        return {
          points: cfg.configuration.mailOnlyZone,
          evidence: 'The zone carries mail records and nothing else at all',
          sourceUrl: sourceUrlFor(facts, 'dns'),
        };
      }
      if (classes.length === 0) return null;

      return {
        points: classes.length * cfg.configuration.recordBreadthPerClass,
        evidence: `Zone carries ${classes.length} record classes: ${classes.join(', ')}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'configuration.title_matches_domain',
    dimension: 'configuration',
    label: 'Site branding matches the domain name',
    rationale:
      'A real business names its site after its domain. A farm domain either serves nothing or serves a generic page unrelated to its own name.',
    weight: (cfg) => fixed(cfg.configuration.titleMatchesDomain),
    evaluate(facts, cfg) {
      if (!facts.site?.titleMatchesDomain) return null;
      return {
        points: cfg.configuration.titleMatchesDomain,
        evidence: `The page title refers to the domain's own name`,
        sourceUrl: facts.site.finalUrl,
      };
    },
  },
  /*
   * There is deliberately no credit for a public registrant organisation, and none for a custom domain
   * connected to a hosted website service.
   *
   * The public-registrant credit was +3 for the unusual case of unredacted registration details. It fired
   * on 58 families and its removal took two abuse domains out of a legitimate band at no cost to any
   * legitimate one. Redaction has become close to universal among the small businesses this was meant to
   * reward, so what is left in the unredacted population is not the population the reasoning assumed.
   *
   * The hosted-service credit was +4 for a paid platform and +2 otherwise. It reached only 11 families
   * across the whole holdout and fired on more legitimate domains than abuse ones without that
   * distinction being measurable either way. The DNS fingerprints it depends on are the narrow part: a
   * platform that changes its custom-domain target silently stops matching, and a credit nobody notices
   * has gone quiet is worse than no credit. This signal was the only reader of the platform table, the
   * `hostedServices` fact and the apex CNAME lookup behind them, so all three went with it rather than
   * being left to decay unread. See `lib/data/dns-services.ts`.
   */

  // ---------------------------------------------------------------------------------------------
  // Organisational footprint: positive-only.
  // ---------------------------------------------------------------------------------------------
  {
    id: 'footprint.saas_vendors',
    dimension: 'footprint',
    label: 'Distinct SaaS vendors verified against this domain',
    rationale:
      'Each verification record was read as the residue of someone completing a domain-verification step inside a paid product, which made the count of distinct vendors a proxy for organisational spend. The residue is indistinguishable from the thing itself: the census matches a TXT prefix, no vendor publishes any way to confirm a token it issued, and invented strings count the same as real ones. It scores nothing and is reported, since a reader can weigh the named vendors themselves.',
    weight: (cfg) =>
      spanning(cfg.footprint.saasVendorTiers.map((tier) => tier.points), 'by how many vendors'),
    evaluate(facts, cfg) {
      const vendors = facts.mail?.saasVendors ?? [];
      if (vendors.length === 0) return null;
      const tier = cfg.footprint.saasVendorTiers.find((entry) => vendors.length >= entry.atLeast);
      if (!tier) return null;
      return {
        points: tier.points,
        evidence: `${vendors.length} distinct vendors verified: ${vendors.slice(0, 8).join(', ')}${vendors.length > 8 ? ', and others' : ''}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  {
    id: 'footprint.dkim',
    dimension: 'footprint',
    label: 'DKIM signing keys published',
    rationale:
      'Published signing keys were read as evidence that mail from this domain is actually signed, which requires configuration on the sending platform as well as in DNS. Only the DNS half is observable, and that half is free: generating a keypair and publishing the public half is one command, and nothing here verifies that any message was ever signed with it. It scores nothing. Selectors cannot be enumerated, so finding none proves nothing either.',
    weight: (cfg) => fixed(cfg.footprint.dkimPresent),
    evaluate(facts, cfg) {
      const selectors = facts.mail?.dkimSelectors ?? [];
      if (selectors.length === 0) return null;
      return {
        points: cfg.footprint.dkimPresent,
        evidence: `DKIM keys published at ${selectors.length} known selector${selectors.length === 1 ? '' : 's'}`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },
  /*
   * There is deliberately no credit for standard business services being configured.
   *
   * Autodiscovery, enterprise enrollment, SIP and calendaring records were read as residue from
   * configuring collaboration systems across an organisation, and paid up to +6 on a tier of how many
   * vendors were found. They are ordinary CNAME and SRV records: pointing one at a vendor requires no
   * account with that vendor, and the calendaring and SIP names were credited for pointing anywhere at
   * all.
   *
   * Six of the DNS queries in `collectDns` existed only to feed this, so retiring the probes with the
   * credit is the substance of the change rather than a side effect. The classifier table went too, and
   * it was already failing quietly: `enterpriseregistration.windows.net` is what that probe returns and
   * it matched no pattern in the table, so 36 of 4,760 stored transcripts paid for an answer the
   * classifier then discarded. See `lib/data/dns-services.ts`.
   */
  {
    id: 'footprint.dnssec',
    dimension: 'footprint',
    label: 'DNSSEC validated',
    rationale:
      'DNSSEC is optional, fiddly and easy to break, so enabling it indicates an operator who cares about correctness. It is the one signal in this dimension still worth points, because it is the only one not taken on the domain\u2019s word: the resolver validated the chain to the root cryptographically, and a broken or absent signature cannot be asserted away. Enabling it is cheap, which is why it pays little. Most legitimate small businesses do not have it, so absence means nothing.',
    weight: (cfg) => fixed(cfg.footprint.dnssec),
    evaluate(facts, cfg) {
      if (!facts.dns?.dnssecValidated) return null;
      return {
        points: cfg.footprint.dnssec,
        evidence: 'The resolver validated this zone with DNSSEC',
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Site existence.
  // ---------------------------------------------------------------------------------------------
  {
    id: 'site.substantive_content',
    dimension: 'site',
    label: 'Serves a real website',
    rationale:
      'A working site with a title and a meaningful amount of readable content is something someone built. Answering the narrow question of whether this domain does anything other than receive mail is the whole purpose of the site probe.',
    weight: (cfg) => fixed(cfg.site.substantiveContent),
    evaluate(facts, cfg) {
      if (!facts.site?.substantive) return null;
      return {
        points: cfg.site.substantiveContent,
        evidence: `Returns ${facts.site.status} with roughly ${facts.site.contentLength} characters of readable content`,
        sourceUrl: facts.site.finalUrl,
      };
    },
  },
  /*
   * There is deliberately no credit for publishing robots.txt.
   *
   * It paid +2 on the reasoning that a robots file implies an audience worth managing. It was the most
   * widely measured of the removals — 721 families — and the reasoning does not survive contact with
   * them: 19% of abuse domains serve one against 26% of legitimate ones, a lift interval that reaches
   * 1.00, and a removal that took 24 abuse domains out of a legitimate band while costing no legitimate
   * domain a verdict. Parking pages and bulk hosting templates ship a robots file by default, so the
   * file measures the hosting stack rather than anyone's intent.
   *
   * This removal also retires the probe: `lib/collect/site.ts` no longer requests the file, which is one
   * fewer round trip inside the site budget.
   */
  /*
   * There is deliberately no penalty for redirecting off the domain.
   *
   * It was removed after measuring it against the labelled benchmark, where it fired on 11 of
   * 62 legitimate domains against 15 of 1,007 abuse domains. Pointing the apex at a platform, a booking
   * page or a social profile is ordinary small-business behaviour, and no classification of the
   * destination separated the two populations. An off-domain redirect still withholds the positive
   * credit, because `substantive` is false when the root does not serve the page itself.
   */
  {
    id: 'site.parked',
    dimension: 'site',
    label: 'Parked or placeholder page',
    rationale:
      'Parking means the domain is held rather than used. Detecting it from the nameservers is more reliable than from page content, since a parked domain must delegate DNS to the parking operator.',
    weight: (cfg) => fixed(cfg.site.parked),
    evaluate(facts, cfg) {
      if (!facts.site?.parked) return null;
      return {
        points: cfg.site.parked,
        evidence: facts.site.parkingEvidence ?? 'The domain serves a parking or placeholder page',
      };
    },
  },
  {
    id: 'site.no_address_when_young',
    dimension: 'site',
    label: 'No web host on a very new domain',
    rationale:
      'A brand new domain with no web host at all has had nothing built on it yet. This is scored only while the domain is new, because a long-established domain with no website is a perfectly ordinary mail-only setup.',
    weight: (cfg) => fixed(cfg.site.noAddressWhenYoung.points),
    evaluate(facts, cfg) {
      if (!facts.dns) return null;
      if (facts.dns.a.length > 0 || facts.dns.aaaa.length > 0) return null;
      const age = ageDays(facts);
      if (age === null || age >= cfg.site.noAddressWhenYoung.underDays) return null;
      return {
        points: cfg.site.noAddressWhenYoung.points,
        evidence: `No A or AAAA record on a domain only ${age} days old`,
        sourceUrl: sourceUrlFor(facts, 'dns'),
      };
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Name shape.
  // ---------------------------------------------------------------------------------------------
  {
    id: 'name.template_digits',
    dimension: 'name',
    label: 'Name follows a numbered template',
    rationale:
      'A word followed by a short run of digits is the shape bulk registration produces when an operator needs many names from one idea. It is weak, because legitimate businesses use numbers too.',
    weight: (cfg) => fixed(cfg.name.templateDigits),
    evaluate(facts, cfg) {
      if (!facts.name.templateDigits) return null;
      return {
        points: cfg.name.templateDigits,
        evidence: 'The name is a word followed by a short run of digits',
      };
    },
  },
  /*
   * There are deliberately no character-shape signals for entropy or hyphenation.
   *
   * Both were measured against the labelled benchmark and neither could fire: per-character entropy
   * peaked at 3.83 bits against a threshold of 4.0, and no label carried more than 2 hyphens against a
   * threshold of 3. Retuning them was rejected rather than skipped. Per-character entropy is maximised by
   * long labels using many distinct characters, which describes a descriptive brand name better than it
   * describes a generated one, so at every threshold low enough to fire it selected legitimate domains
   * ahead of abuse. Hyphen counting has the same defect in weaker form. Separating a generated label from
   * a chosen one needs a model of what a pronounceable name looks like, which a character histogram is
   * not. See `docs/CALIBRATION.md`.
   */
  {
    id: 'name.vetted_suffix',
    dimension: 'name',
    label: 'Restricted or accredited suffix',
    rationale:
      'Government, academic and military suffixes are gated by an accreditation process that cannot be passed in bulk, which makes them the strongest positive in the model. This is also what protects institutional mail, where large numbers of similar addresses are entirely legitimate.',
    weight: (cfg) => fixed(cfg.name.vettedSuffix),
    evaluate(facts, cfg) {
      if (!facts.meta.vettedSuffix) return null;
      return {
        points: cfg.name.vettedSuffix,
        evidence: `Registered under the accredited .${facts.meta.vettedSuffix} suffix`,
      };
    },
  },
];

/** Computed locally, with no network, so it is always available. */
export function nameFacts(label: string): NameFacts {
  return {
    templateDigits: /^[a-z][a-z-]{2,}\d{3,6}$/.test(label),
  };
}
