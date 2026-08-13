import { DEFAULT_CONFIG, type ScoringConfig } from '../../lib/scoring/weights';

/**
 * Tunable scalars, swept out-of-fold.
 *
 * This is the one part of the audit that could quietly turn the holdout into training data, so the
 * protocol matters more than the result. Picking the value that scores best on the whole set would
 * measure how well a number can be fitted to a few thousand domains, which is not a question anyone
 * asked. Each fold chooses its value on four fifths of the families and is then scored on the fifth it never
 * saw, so what gets reported is what the *procedure* is worth on unseen domains rather than what the
 * best number is worth on seen ones. A change is only adopted when it wins that way.
 *
 * Folds are drawn over families, not domains, for the same reason the intervals are: splitting one
 * operator's names across train and test would leak the answer and make every knob look adoptable.
 */
export type Knob = {
  id: string;
  current: number;
  values: number[];
  reason: string;
  apply(cfg: ScoringConfig, value: number): void;
};

/**
 * The values swept are whole points throughout, which is a constraint on the search and not an accident
 * of which numbers were typed. The point tables are meant to be added up by hand from the evidence list
 * in a response, and a fractional weight breaks that for a gain the sweep cannot distinguish from its
 * neighbours anyway. A first pass allowing halves picked 1.5 over 1 and 2; the difference between them is
 * well inside what a different fold split would move.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export const KNOBS: Knob[] = [
  {
    id: 'configuration.recordBreadthPerClass',
    current: DEFAULT_CONFIG.configuration.recordBreadthPerClass,
    values: [1, 2, 3],
    reason:
      'the credit fires on most of the abuse group and its removal moves a large number of abuse domains out of a legitimate band, so it may simply be priced too high',
    apply: (cfg, value) => {
      (cfg.configuration as any).recordBreadthPerClass = value;
    },
  },
  {
    id: 'clamps.configuration.max',
    current: DEFAULT_CONFIG.clamps.configuration.max,
    values: [4, 6, 8, 10, 12],
    reason: 'the same credit again, bounded rather than repriced',
    apply: (cfg, value) => {
      (cfg.clamps.configuration as any).max = value;
    },
  },
  {
    id: 'age.oldestTierPoints',
    current: 20,
    values: [8, 12, 16, 20],
    reason: 'age is the strongest dimension, and the top of its positive range is the least evidenced part',
    apply: (cfg, value) => {
      const tiers = cfg.age.tiers as any[];
      tiers[tiers.length - 1].points = value;
    },
  },
  {
    id: 'combinations.totalCap',
    current: DEFAULT_CONFIG.combinations.totalCap,
    values: [20, 30, 40, 50, 60],
    reason: 'bounds how much the conjunctions may say in total, and was never measured',
    apply: (cfg, value) => {
      (cfg.combinations as any).totalCap = value;
    },
  },
  {
    id: 'signup.freeRouting',
    current: DEFAULT_CONFIG.signup.freeRouting,
    values: [-27, -24, -21, -18, -15, -12],
    reason: 'the largest single contributor to band-level recall, previously swept only in-sample',
    apply: (cfg, value) => {
      (cfg.signup as any).freeRouting = value;
    },
  },
  {
    id: 'site.hostedPlatform',
    current: DEFAULT_CONFIG.site.hostedPlatform,
    values: [0, 2, 4, 6],
    reason:
      'a reinstated credit entered at zero so shipping nothing is among the candidates, and capped low because clamps.site.max is 6 and substantiveContent alone reaches it',
    apply: (cfg, value) => {
      (cfg.site as any).hostedPlatform = value;
    },
  },
  {
    id: 'site.parked',
    current: DEFAULT_CONFIG.site.parked,
    values: [-18, -15, -12, -9, -6],
    reason: 'the signal where ranking and bands disagree most sharply',
    apply: (cfg, value) => {
      (cfg.site as any).parked = value;
    },
  },
  /*
   * The two 1.5.0 weights, entered at zero so that the sweep places them rather than confirming a
   * number somebody chose first. A knob whose current value is zero is the honest way to ask this
   * question: every candidate is judged against shipping nothing, so the signal has to earn its weight
   * outright instead of defending one it was given.
   */
  {
    id: 'signup.wildcardMx',
    current: DEFAULT_CONFIG.signup.wildcardMx,
    values: [0, -3, -6, -9, -12, -15],
    reason: 'a new signal, and the only one that observes unlimited addressing directly rather than inferring it from a provider class',
    apply: (cfg, value) => {
      (cfg.signup as any).wildcardMx = value;
    },
  },
];
/* eslint-enable @typescript-eslint/no-explicit-any */
