import { ageDays, firstSeen, type DomainFacts } from '../facts';
import { SIGNALS, type SignalResult } from './signals';
import { observe, type ObservationResult } from './observations';
import { evaluateCombinations, type CombinationResult } from './combinations';
import { clamp, DEFAULT_CONFIG, type Dimension, type ScoringConfig, type Verdict } from './weights';
import { verdictFor } from './verdict';
import { narrate } from './narrative';

/**
 * Scoring is a pure function of facts plus config, with no I/O.
 *
 * That is the property that makes the scheme tunable: a fixture is a stored facts snapshot, so any
 * weight change can be re-tested offline with no network and no risk of a source having changed
 * underneath the test.
 *
 * Evaluation order is fixed and documented, because the result depends on it: signals, then discounts,
 * then bonuses, then overrides, then per-dimension clamps, then bands.
 */

export type ReasonFlag =
  | 'disposable'
  | 'forwarder'
  | 'catch_all_capable'
  | 'no_mx'
  | 'too_new'
  | 'provider_subdomain'
  | 'free_subdomain'
  | 'parked'
  | 'farm_profile'
  | 'registrar_default'
  | 'registry_hold';

/**
 * A signal that did not apply, which renders differently from one that applied and scored zero. It
 * carries the definition's fixed text and no evidence, because there was nothing to observe.
 */
export type InapplicableSignal = {
  id: string;
  label: string;
  rationale: string;
};

export type DimensionSubtotal = {
  dimension: Dimension;
  raw: number;
  clamped: number;
  clamp: { min: number; max: number };
  /** True when the clamp actually bound, which is worth showing rather than hiding. */
  clampApplied: boolean;
};

export type ScoreResult = {
  modelVersion: string;
  legitimacy: number;
  risk: number;
  confidence: number;
  verdict: Verdict;
  flags: ReasonFlag[];
  narrative: string;
  dimensions: DimensionSubtotal[];
  signals: SignalResult[];
  inapplicableSignals: InapplicableSignal[];
  /** Facts collected and reported beside the verdict that move no score by construction. */
  observations: ObservationResult[];
  combinations: CombinationResult[];
  firstSeen?: { date: string; source: string };
  ageDays?: number;
};

/**
 * `exclude` suppresses named signals as if they had not applied, which is how the audit measures what a
 * signal is worth: a signal is only justified if removing it makes the model measurably worse. Removal
 * propagates through the combinations, since those key off which signals fired. Nothing in the shipping
 * path passes it.
 */
export function score(
  facts: DomainFacts,
  cfg: ScoringConfig = DEFAULT_CONFIG,
  exclude?: ReadonlySet<string>,
): ScoreResult {
  // 1. Signals.
  const signals: SignalResult[] = [];
  const inapplicable: InapplicableSignal[] = [];

  for (const definition of SIGNALS) {
    const outcome = exclude?.has(definition.id) ? null : definition.evaluate(facts, cfg);
    if (outcome === null) {
      inapplicable.push({
        id: definition.id,
        label: definition.label,
        rationale: definition.rationale,
      });
      continue;
    }
    signals.push({
      id: definition.id,
      dimension: definition.dimension,
      label: definition.label,
      rationale: definition.rationale,
      points: outcome.points,
      evidence: outcome.evidence,
      sourceUrl: outcome.sourceUrl,
    });
  }

  // 2-4. Discounts, bonuses and overrides, all produced by one pass so their interaction is visible.
  const combos = evaluateCombinations(facts, signals, cfg, exclude);

  // 5. Per-dimension summation and clamping. Signals contribute their own points and nothing rescales
  // them: the one combination that used to, the correlated-absence group, now protects its domains by
  // its members scoring zero rather than by discounting them. See `lib/scoring/weights.ts`.
  const dimensions: DimensionSubtotal[] = [];
  const dimensionKeys = Object.keys(cfg.clamps) as Dimension[];

  for (const dimension of dimensionKeys) {
    const raw = signals
      .filter((signal) => signal.dimension === dimension)
      .reduce((total, signal) => total + signal.points, 0);

    const limits = cfg.clamps[dimension];
    const clamped = clamp(raw, limits.min, limits.max);

    dimensions.push({
      dimension,
      raw: round(raw),
      clamped: round(clamped),
      clamp: limits,
      clampApplied: Math.abs(raw - clamped) > 0.01,
    });
  }

  const dimensionTotal = dimensions.reduce((total, entry) => total + entry.clamped, 0);

  // Combination points sit outside the dimension clamps by design, since a conjunction is about the
  // interaction rather than about any one dimension, but they carry their own total cap.
  const comboTotal = clamp(
    combos.results.reduce((total, entry) => total + entry.points, 0),
    -cfg.combinations.totalCap,
    cfg.combinations.totalCap,
  );

  let legitimacy = cfg.neutralBase + dimensionTotal + comboTotal;

  // 6. Overrides that bound the result, applied last so nothing can climb back past them.
  const statuses = facts.registration?.statuses ?? [];
  const onHold = statuses.some((status) => status === 'serverhold' || status === 'clienthold');
  if (onHold) {
    legitimacy = Math.min(legitimacy, cfg.overrides.registryHoldCap);
  }
  if (combos.floor !== undefined) {
    legitimacy = Math.max(legitimacy, combos.floor);
  }

  legitimacy = Math.round(clamp(legitimacy, 0, 100));

  const confidence = computeConfidence(facts, cfg);
  const age = ageDays(facts);
  const seen = firstSeen(facts);

  const result: ScoreResult = {
    modelVersion: cfg.modelVersion,
    legitimacy,
    risk: 100 - legitimacy,
    confidence,
    verdict: verdictFor(legitimacy, confidence, cfg),
    flags: deriveFlags(facts, signals, combos.results, age),
    narrative: '',
    dimensions,
    signals,
    inapplicableSignals: inapplicable,
    observations: observe(facts),
    combinations: combos.results,
    firstSeen: seen ?? undefined,
    ageDays: age ?? undefined,
  };

  result.narrative = narrate(result, facts);
  return result;
}

/**
 * Confidence is coverage: the weighted share of dimension groups that actually returned data.
 *
 * This is what lets the model say "insufficient evidence" instead of accusing a domain when the sources
 * simply did not answer. Missing data can only ever reduce confidence and never move the score.
 */
function computeConfidence(facts: DomainFacts, cfg: ScoringConfig): number {
  const weights = cfg.confidence.weights;
  let earned = 0;
  let available = 0;

  const groups: { weight: number; present: boolean; applicable: boolean }[] = [
    {
      weight: weights.registration,
      // Coverage is the creation date specifically, not the record. Several registries answer in full
      // over WHOIS while publishing no registration date at all, and counting those as covered would
      // report confidence in an age the model does not have.
      present: Boolean(facts.registration?.creation),
      // Registration data is genuinely inapplicable for a platform-issued name, so its absence should
      // not be counted against confidence.
      applicable: !facts.meta.providerSuffix,
    },
    { weight: weights.dnsAndMail, present: Boolean(facts.dns), applicable: true },
    { weight: weights.signup, present: Boolean(facts.signup), applicable: true },
    { weight: weights.site, present: Boolean(facts.site), applicable: true },
    {
      weight: weights.pricing,
      present: Boolean(facts.pricing && !facts.pricing.unpriced),
      applicable: !facts.meta.providerSuffix,
    },
    /*
     * The reputation source is deliberately absent from this list, and its omission is not an
     * oversight to be corrected.
     *
     * Confidence is coverage of the evidence the verdict rests on, and this source is metered: it can
     * go dark partway through a month with every other upstream healthy. Given a weight, an exhausted
     * allowance would drag every domain analysed afterwards toward `insufficient_evidence` — turning a
     * billing event into a verdict about domains it says nothing about. It can only ever add a
     * penalty or a single point, so the score already reflects exactly what it did or did not
     * contribute, and its status is rendered in the source panel regardless.
     */
  ];

  for (const group of groups) {
    if (!group.applicable) continue;
    available += group.weight;
    if (group.present) earned += group.weight;
  }

  let confidence = available > 0 ? (earned / available) * 100 : 0;

  // A long-established domain whose mail is handled by a throwaway-inbox service is a contradiction, not
  // an average.
  const age = ageDays(facts);
  if (age !== null && age > 3650 && facts.signup?.class === 'temp_mail') {
    confidence -= cfg.confidence.conflictPenalty;
  }

  return Math.round(clamp(confidence, 0, 100));
}

function deriveFlags(
  facts: DomainFacts,
  signals: SignalResult[],
  combinations: CombinationResult[],
  age: number | null,
): ReasonFlag[] {
  const flags = new Set<ReasonFlag>();
  const fired = new Set(signals.map((signal) => signal.id));

  // Either route to the same conclusion raises the same flag. A -40 penalty rendered without the pill
  // that names it would leave a consumer filtering on flags unable to see the reason for the score.
  if (
    facts.signup?.class === 'temp_mail' ||
    facts.checkmail?.disposable ||
    (facts.mail?.disposableVerification?.length ?? 0) > 0
  ) {
    flags.add('disposable');
  }
  if (facts.signup?.class === 'forwarder' || facts.meta.relayDomain) flags.add('forwarder');
  // A wildcard MX is the capability this flag names, stated more directly than free routing states it:
  // the zone answers for addresses nobody has created yet.
  if (facts.signup?.class === 'free_routing' || (facts.signup?.wildcardMx?.hosts.length ?? 0) > 0) {
    flags.add('catch_all_capable');
  }
  if (facts.dns && facts.dns.mx.length === 0) flags.add('no_mx');
  if (age !== null && age < 30) flags.add('too_new');
  if (facts.meta.providerSuffix) flags.add('provider_subdomain');
  if (facts.meta.providerSuffix?.kind === 'free_subdomain') flags.add('free_subdomain');
  if (facts.site?.parked) flags.add('parked');
  if (fired.has('age.registry_hold')) flags.add('registry_hold');
  if (combinations.some((combo) => combo.id === 'combo.farm_profile')) flags.add('farm_profile');
  if (combinations.some((combo) => combo.id === 'combo.registrar_default_profile')) {
    flags.add('registrar_default');
  }

  return [...flags];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
