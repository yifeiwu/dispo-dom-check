/**
 * The statistics the audit is built on, separated from the reports that print them.
 *
 * Nothing here knows what a signal or a domain is: every function takes numbers and returns numbers.
 * That is the point of the split. The reports are long because they are mostly formatting, and the
 * arithmetic underneath them is the part where being wrong is silent — an interval computed with the
 * normal approximation instead of Wilson still prints, and still looks like a measurement.
 */

export const pct = (value: number) => `${Math.round(value * 100)}%`;
export const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;

/**
 * Wilson score interval, which is the right binomial interval at the counts this report deals in.
 *
 * The normal approximation collapses when a signal fires a handful of times or fires unanimously, and
 * those are precisely the cases the tiering has to rule on. Wilson stays inside [0,1] and does not
 * degenerate to a zero-width interval at p=0 or p=1, so "fired on 9 domains, all abuse" comes out as the
 * weak evidence it is rather than as certainty.
 */
export function wilson(successes: number, trials: number, z = 1.96): [number, number] {
  if (trials === 0) return [0, 1];
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return [Math.max(0, (centre - spread) / denominator), Math.min(1, (centre + spread) / denominator)];
}

/** Deterministic generator, so a re-run compares against the same resamples as the run before. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return NaN;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[at];
}

export function distribution(
  values: number[],
): { n: number; median: number; mean: number; p10: number; p90: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    n: sorted.length,
    median: sorted.length ? at(0.5) : NaN,
    mean: sorted.length ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10 : NaN,
    p10: sorted.length ? at(0.1) : NaN,
    p90: sorted.length ? at(0.9) : NaN,
  };
}

/**
 * Score histograms, exploiting the fact that `legitimacy` is a rounded integer in [0,100].
 *
 * Every measurement in the report is some AUC over a resampled cohort, thousands of times over, and the
 * rank-based form is O(n log n) with an allocation per call. Bucketing by score makes each AUC a linear
 * pass and a 101-bin sweep, which is what makes a cluster bootstrap over every signal affordable.
 */
const SCORE_BINS = 101;

/**
 * Builds the AUC estimator for one cohort, holding the scratch histograms the resampling reuses.
 *
 * A factory rather than a plain function because those two buffers are the whole optimisation, and
 * they were previously module-level arrays mutated by a function several hundred lines away. Closing
 * over them keeps the reuse and removes the possibility of anything else reading them mid-sweep.
 */
export function createAucEstimator(
  families: readonly { members: number[] }[],
  weights: Float64Array,
): (scores: Int32Array, abuseDraw: Int32Array, legitDraw: Int32Array) => number {
  const abuseHistogram = new Float64Array(SCORE_BINS);
  const legitHistogram = new Float64Array(SCORE_BINS);

  return function weightedAucOver(scores, abuseDraw, legitDraw) {
    abuseHistogram.fill(0);
    legitHistogram.fill(0);
    let abuseMass = 0;
    let legitMass = 0;
    for (const family of abuseDraw) {
      for (const member of families[family].members) {
        abuseHistogram[scores[member]] += weights[member];
        abuseMass += weights[member];
      }
    }
    for (const family of legitDraw) {
      for (const member of families[family].members) {
        legitHistogram[scores[member]] += weights[member];
        legitMass += weights[member];
      }
    }

    if (abuseMass <= 0 || legitMass <= 0) return NaN;
    // P(a legitimate domain scores above an abuse one) plus half the ties, which is the quantity
    // averaged ranks compute when ranking by risk. Ties are heavy here, since the scores are coarse
    // integers.
    let above = legitMass;
    let total = 0;
    for (let score = 0; score < SCORE_BINS; score += 1) {
      above -= legitHistogram[score];
      total += abuseHistogram[score] * (above + 0.5 * legitHistogram[score]);
    }
    return total / (abuseMass * legitMass);
  };
}
