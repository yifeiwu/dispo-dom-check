import { ageDays, type DomainFacts } from '../facts';
import type { ScoringConfig } from './weights';
import type { SignalResult } from './signals';

/**
 * Combinations: where the whole differs from the sum of the parts.
 *
 * A purely additive model errs in both directions. It misses conjunctions where each part has an
 * innocent explanation that only the combination eliminates, and it double-counts correlated signals,
 * which is how a legitimate small business accumulates penalties merely for being unsophisticated. Both
 * halves matter equally, and the subadditive half is what keeps false positives off ordinary domains.
 *
 * Interaction terms are also where overfitting enters. Each of these is a hand-crafted prior rather than
 * a learned weight, so the set stays small, each carries a written rationale, each is pinned by a
 * fixture, and the total contribution is capped.
 */

export type CombinationMode = 'bonus' | 'discount' | 'override';

export type CombinationDefinition = {
  id: string;
  mode: CombinationMode;
  label: string;
  rationale: string;
  /** Signal ids that must all have fired for this combination to apply. */
  requires: string[];
  points?: number;
  /**
   * Extra conditions beyond signal presence, for the cases where the conjunction depends on a fact
   * rather than on another signal having fired.
   */
  applies?(facts: DomainFacts, fired: Set<string>, cfg: ScoringConfig): boolean;
};

export type CombinationResult = {
  id: string;
  mode: CombinationMode;
  label: string;
  rationale: string;
  points: number;
  evidence: string;
};

const hasSite = (facts: DomainFacts): boolean => facts.site?.substantive === true;

/**
 * Whether the domain can receive mail at all.
 *
 * Read from the facts rather than from a fired signal, because presence of MX scores nothing on its own:
 * an account farmer needs a working mailbox to collect verification codes, so inbound mail is a
 * precondition of the abuse rather than evidence in either direction. It is a condition of the two
 * conjunctions below, where what does the work is the pairing of a live mailbox with a domain that has
 * nothing else going on.
 */
const hasMx = (facts: DomainFacts): boolean => (facts.dns?.mx.length ?? 0) > 0;

/**
 * True when the first-year price sits in the most heavily penalised tier of the price table.
 *
 * This is the second way a suffix can offer no brake on disposal, alongside a steep renewal ratio: some
 * registries are simply cheap in perpetuity, so year one is never discounted and the ratio stays near
 * parity. The threshold is read out of the tier table rather than declared separately, so the two cannot
 * drift apart, and it is the registration price rather than the renewal price on purpose. Renewal price
 * alone does not separate the populations: the cheapest renewals in the feed belong to efficient
 * non-profit registries whose registration price is several dollars, and penalising those would land on
 * whole national small-business populations rather than on disposable domains.
 */
function deeplyDiscounted(facts: DomainFacts, cfg: ScoringConfig): boolean {
  const price = facts.pricing?.registration;
  if (price === undefined) return false;
  const deepest = cfg.economics.priceTiers.reduce((worst, tier) =>
    tier.points < worst.points ? tier : worst,
  );
  return price < deepest.under;
}

export const COMBINATIONS: readonly CombinationDefinition[] = [
  // -------------------------------------------------------------------------------------------
  // Superadditive: the conjunction eliminates the innocent explanation each part has alone.
  // -------------------------------------------------------------------------------------------
  {
    id: 'combo.farm_profile',
    mode: 'bonus',
    label: 'Farm profile: cheap disposable suffix, first term, mail configured, no website',
    rationale:
      'Each part of this has an innocent explanation on its own. A new cheap domain may be a startup, and a domain that only handles mail is a legitimate setup. Together they describe a domain whose sole function is receiving mail at throwaway cost, which is the account-farm profile exactly.',
    requires: [],
    applies(facts, fired, cfg) {
      if (!hasMx(facts)) return false;
      /*
       * Read from the facts rather than from a fired signal, because a name issued free by a subdomain
       * provider no longer scores on its own. The conjunction is unaffected by that: it needs to know
       * that the name was free, which is a property of the suffix, and not that some other signal chose
       * to charge points for it.
       */
      const free = facts.meta.providerSuffix?.kind === 'free_subdomain';
      const cheap = fired.has('economics.first_year_price') || free;
      // Disposal is unbraked either because year one was discounted and the real price is never paid, or
      // because the suffix is at the bottom of the price table and there was never a real price to pay.
      const noBrakeOnDisposal = fired.has('economics.renewal_ratio') || free || deeplyDiscounted(facts, cfg);
      const age = ageDays(facts);
      const insideFirstTerm = age !== null && age < 366;
      return cheap && noBrakeOnDisposal && insideFirstTerm && !hasSite(facts);
    },
  },
  {
    id: 'combo.free_routing_young_no_site',
    mode: 'bonus',
    label: 'Free unlimited-alias routing on a young domain with no website',
    rationale:
      'Free routing alone is common among hobbyists, which is why it is only a moderate penalty by itself. On a domain a few weeks old with nothing served on it, the hobbyist explanation is gone and what remains is unlimited disposable addressing bought for nothing.',
    requires: ['signup.free_routing'],
    applies(facts, _fired, cfg) {
      const age = ageDays(facts);
      return age !== null && age < cfg.combinations.freeRoutingYoungNoSite.maxAgeDays && !hasSite(facts);
    },
  },
  {
    id: 'combo.registrar_default_profile',
    mode: 'bonus',
    label: 'Young mail-only domain left on registrar defaults',
    rationale:
      'Default nameservers are common and harmless alone. When the same registrar also supplies catch-all forwarding, the domain is young, and no site was configured, the untouched template describes a mailbox-only registration requiring almost no effort.',
    requires: ['signup.free_routing'],
    applies(facts, _fired, cfg) {
      if (!facts.registrarDefault) return false;
      const age = ageDays(facts);
      return (
        age !== null &&
        age < cfg.combinations.registrarDefaultProfile.maxAgeDays &&
        !hasSite(facts)
      );
    },
  },
  {
    id: 'combo.inbound_without_outbound',
    mode: 'bonus',
    label: 'Unlimited inbound aliasing with no sending identity at all',
    rationale:
      'This uses absence without breaking the rule that missing DMARC is never penalised alone. The signal is the pairing: someone who configured unlimited inbound aliasing but invested nothing in being able to send is set up to receive verification messages and nothing else.',
    requires: [],
    applies(facts, fired) {
      const aliasing = fired.has('signup.free_routing') || fired.has('signup.forwarder');
      const noOutbound =
        !facts.mail?.spf && (facts.mail?.dkimSelectors.length ?? 0) === 0 && !facts.mail?.dmarcPolicy;
      return aliasing && noOutbound;
    },
  },
  {
    id: 'combo.parked_with_mx',
    mode: 'bonus',
    label: 'Parked page but mail is configured',
    rationale:
      'Parking a domain normally means nothing is running on it, mail included. A parked page with working mail describes a name whose only live function is its mailbox.',
    requires: ['site.parked'],
    applies: hasMx,
  },

  // -------------------------------------------------------------------------------------------
  // Sign-flipping overrides: these invert a signal rather than nudging the total.
  // -------------------------------------------------------------------------------------------
  /*
   * There is deliberately no drop-catch override.
   *
   * Detecting a domain that lapsed and was recaught needs an independent history to compare the
   * registration date against, so that a gap between the two can be established. With the certificate
   * and archive sources gone there is no such history: RDAP's `lastChanged` alone fires on any
   * modification at all, including routine maintenance, and would penalise well-run domains for being
   * actively maintained. Age credit is therefore inherited by a new owner, which is a known gap rather
   * than an oversight.
   */
  {
    id: 'combo.conclusive_legitimacy',
    mode: 'override',
    label: 'Conclusively established: accredited suffix, real age and paid mail',
    rationale:
      'No plausible account-farm domain holds an accredited suffix, several years of history and a paid per-seat mail tenancy at the same time. Positive overrides exist to keep false-positive pressure off established organisations, which is the failure mode that costs a consumer real users.',
    requires: ['name.vetted_suffix', 'signup.paid_tenant'],
    applies(facts, _fired, cfg) {
      const age = ageDays(facts);
      return age !== null && age >= cfg.combinations.conclusiveLegitimacyMinAgeDays;
    },
  },

  // -------------------------------------------------------------------------------------------
  // Subadditive: the half that protects legitimate but unsophisticated domains.
  // -------------------------------------------------------------------------------------------
  /*
   * There is deliberately no discount for cheap first-year pricing correlating with a steep renewal.
   *
   * The reasoning was sound and the measurement contradicts it. Subadditive combinations exist to protect
   * legitimate but unsophisticated domains from accumulating penalties for one underlying fact, and this
   * one protected nobody it was written for: it applied to 30% of abuse domains and 0% of legitimate ones,
   * because a legitimate business on a cheap suffix that also renews steeply is close to a null set while
   * a bulk registration on one is the ordinary case. Removing it took 24 abuse domains out of a
   * legitimate band and cost no legitimate domain a verdict.
   *
   * The correlation it described is real, and the answer to it is that the two signals be weighted for
   * the fact they jointly measure, which the price tiers and renewal ratio now are. Discounting a penalty
   * that only ever applies to the guilty is not conservatism, it is a leak.
   */
  {
    id: 'combo.correlated_absence',
    mode: 'discount',
    label: 'Missing mail hygiene records measure one underlying fact',
    rationale:
      'Absent DMARC, absent DNSSEC and absent vendor verification records are three measurements of a single latent factor: an operator who never got round to any of it. That describes most legitimate small businesses, so none of the three is charged at all rather than being allowed to accumulate into a verdict. This group used to be discounted instead; it needs no discount now that its members score nothing, and it is still reported so the conjunction is visibly noticed rather than silently passed over.',
    requires: [],
    applies(facts) {
      const missing =
        (facts.mail && !facts.mail.dmarcPolicy ? 1 : 0) +
        (facts.dns && !facts.dns.dnssecValidated ? 1 : 0) +
        (facts.mail && facts.mail.saasVendors.length === 0 ? 1 : 0);
      return missing >= 2;
    },
  },
];

export type CombinationOutcome = {
  results: CombinationResult[];
  /** Floor applied to the final score, from a positive override. */
  floor?: number;
};

export function evaluateCombinations(
  facts: DomainFacts,
  signals: SignalResult[],
  cfg: ScoringConfig,
  exclude?: ReadonlySet<string>,
): CombinationOutcome {
  const fired = new Set(signals.map((signal) => signal.id));
  const results: CombinationResult[] = [];
  let floor: number | undefined;

  for (const combination of COMBINATIONS) {
    if (exclude?.has(combination.id)) continue;
    const requirementsMet = combination.requires.every((id) => fired.has(id));
    if (!requirementsMet) continue;
    if (combination.applies && !combination.applies(facts, fired, cfg)) continue;

    switch (combination.id) {
      case 'combo.farm_profile': {
        results.push(describe(combination, cfg.combinations.farmProfile, 'All four conditions hold together'));
        break;
      }
      case 'combo.free_routing_young_no_site': {
        const age = ageDays(facts);
        results.push(
          describe(
            combination,
            cfg.combinations.freeRoutingYoungNoSite.points,
            `Free routing on a domain ${age} days old with no substantive website`,
          ),
        );
        break;
      }
      case 'combo.inbound_without_outbound': {
        results.push(
          describe(
            combination,
            cfg.combinations.inboundWithoutOutbound,
            'Alias-capable inbound mail with no SPF, DKIM or DMARC at all',
          ),
        );
        break;
      }
      case 'combo.registrar_default_profile': {
        const provider = facts.registrarDefault?.provider ?? 'the registrar';
        results.push(
          describe(
            combination,
            cfg.combinations.registrarDefaultProfile.points,
            `${provider} default nameservers and forwarding remain on a young domain with no substantive site`,
          ),
        );
        break;
      }
      case 'combo.parked_with_mx': {
        results.push(describe(combination, cfg.combinations.parkedWithMx, 'Parked page with configured mail'));
        break;
      }
      case 'combo.conclusive_legitimacy': {
        floor = cfg.combinations.conclusiveLegitimacyFloor;
        results.push(
          describe(combination, 0, `Score floored at ${cfg.combinations.conclusiveLegitimacyFloor} by positive override`),
        );
        break;
      }
      case 'combo.correlated_absence': {
        results.push(
          describe(
            combination,
            0,
            'No penalty applied for absent DMARC, DNSSEC or vendor verification records, which are treated as one absence and never as evidence',
          ),
        );
        break;
      }
      default:
        break;
    }
  }

  return { results, floor };
}

function describe(
  combination: CombinationDefinition,
  points: number,
  evidence: string,
): CombinationResult {
  return {
    id: combination.id,
    mode: combination.mode,
    label: combination.label,
    rationale: combination.rationale,
    points,
    evidence,
  };
}
