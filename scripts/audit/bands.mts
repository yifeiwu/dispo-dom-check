import { DEFAULT_CONFIG } from '../../lib/scoring/weights';
import { score } from '../../lib/scoring/score';
import { isAbuse, isGraded, isLegitimate, orderedLabels, type Group } from '../benchmark.mts';
import type { Cached } from './cache.mts';
import { distribution } from './stats.mts';

/**
 * Does the model separate the labels, and are the band boundaries in the right place?
 *
 * Held apart from the ablation report, which asks the different question of whether each individual
 * heuristic earns its place. Both read the same cached facts, so a figure here and a figure there
 * describe one set of observations, but this half is cheap and that half costs several hundred bootstrap
 * resamples per signal — which is why `--bands` exists and why this is the module it lives in.
 */

/**
 * Positive class is abuse, negative is legitimate. Privacy sits out of the headline metric on purpose:
 * the model deliberately flags forwarders without condemning them, so scoring them as either class would
 * measure a policy choice rather than an error. Their firing rates are still printed, one column over.
 */
export type Scored = {
  entry: Cached;
  legitimacy: number;
  confidence: number;
  verdict: string;
  flags: string[];
  abuse: boolean;
  legit: boolean;
};

export function scoreAll(cached: readonly Cached[], exclude?: ReadonlySet<string>): Scored[] {
  return cached.map((entry) => {
    const result = score(entry.facts, DEFAULT_CONFIG, exclude);
    return {
      entry,
      legitimacy: result.legitimacy,
      confidence: result.confidence,
      verdict: result.verdict,
      flags: result.flags,
      abuse: isAbuse(entry),
      legit: isLegitimate(entry),
    };
  });
}

/**
 * The three heaviest signals behind one verdict, recomputed for the handful of domains actually listed
 * rather than carried on every row. `scoreAll` runs once per ablation over the whole holdout, so a
 * per-row array of drivers would be allocated some tens of thousands of times to be read a dozen.
 */
function topDrivers(entry: Cached): string {
  return [...score(entry.facts, DEFAULT_CONFIG).signals]
    .filter((signal) => signal.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 3)
    .map((signal) => `${signal.id}(${signal.points})`)
    .join(' ');
}

export function reportBands(cached: readonly Cached[], scored: Scored[]): void {
  const labels = orderedLabels(cached);
  /** Marks the group that is reported but never graded, so no reader mistakes a row for an error rate. */
  const note = (group: Group) => (group === 'privacy' ? '  (not graded)' : '');
  const inLabel = (label: string) => scored.filter((row) => row.entry.label === label);

  console.log('\n=== Score distribution by label (legitimacy, higher is more legitimate) ===');
  for (const { label, group } of labels) {
    const rows = inLabel(label);
    const legitimacy = distribution(rows.map((row) => row.legitimacy));
    const confidence = distribution(rows.map((row) => row.confidence));
    console.log(
      `${label.padEnd(14)} n=${String(legitimacy.n).padStart(4)}  median=${String(legitimacy.median).padStart(3)}  ` +
        `mean=${String(legitimacy.mean).padStart(5)}  p10=${String(legitimacy.p10).padStart(3)}  ` +
        `p90=${String(legitimacy.p90).padStart(3)}  confidence median=${confidence.median}${note(group)}`,
    );
  }

  console.log('\n=== Verdict distribution by label ===');
  for (const { label, group } of labels) {
    const tally = new Map<string, number>();
    for (const row of inLabel(label)) tally.set(row.verdict, (tally.get(row.verdict) ?? 0) + 1);
    const rendered = [...tally]
      .sort((a, b) => b[1] - a[1])
      .map(([verdict, count]) => `${verdict}=${count}`)
      .join(' ');
    console.log(`${label.padEnd(14)} ${rendered}${note(group)}`);
  }

  console.log('\n=== Flag hit rate by label ===');
  for (const { label, group } of labels) {
    const rows = inLabel(label);
    const tally = new Map<string, number>();
    for (const row of rows) for (const name of row.flags) tally.set(name, (tally.get(name) ?? 0) + 1);
    const rendered = [...tally]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}=${Math.round((count / rows.length) * 100)}%`)
      .join(' ');
    console.log(`${label.padEnd(14)} ${rendered || 'none'}${note(group)}`);
  }

  const abuse = scored.filter((row) => row.abuse);
  const legit = scored.filter((row) => row.legit);
  const ungraded = scored.filter((row) => !isGraded(row.entry));

  const riskBand = (row: Scored) => row.verdict === 'high_risk' || row.verdict === 'suspicious';
  const legitimateBand = (row: Scored) =>
    row.verdict === 'probably_legitimate' || row.verdict === 'established';
  const share = (part: Scored[], whole: Scored[]) =>
    whole.length === 0 ? '-' : `${Math.round((part.length / whole.length) * 100)}%`;

  /*
   * The failures worth acting on. A legitimate domain scored as risky is the expensive error, because it
   * blocks a real user, so those are listed with their drivers to show which weight caused it.
   */
  console.log('\n=== False positives: legitimate domains landing in a risk band ===');
  const falsePositives = legit.filter(riskBand);
  console.log(
    falsePositives.length === 0
      ? 'none'
      : `${falsePositives.length} of ${legit.length} (${share(falsePositives, legit)})`,
  );
  for (const row of falsePositives) {
    console.log(`  ${row.legitimacy}  ${row.verdict.padEnd(12)} ${topDrivers(row.entry)}`);
  }

  console.log('\n=== False negatives: abuse domains landing in a legitimate band ===');
  const falseNegatives = abuse.filter(legitimateBand);
  console.log(
    falseNegatives.length === 0
      ? 'none'
      : `${falseNegatives.length} of ${abuse.length} (${share(falseNegatives, abuse)})`,
  );
  for (const row of falseNegatives.slice(0, 15)) {
    console.log(`  ${row.legitimacy}  ${row.verdict.padEnd(20)} ${topDrivers(row.entry)}`);
  }

  /*
   * Where the ungraded group actually lands. It is spread across the bands rather than concentrated in
   * one, which is the expected shape: a forwarder is flagged for its capability, and the rest of its
   * configuration then decides the verdict like any other domain.
   */
  if (ungraded.length > 0) {
    console.log('\n=== Privacy and forwarder domains: reported, never graded ===');
    console.log(
      `${ungraded.length} scored: ${share(ungraded.filter(riskBand), ungraded)} in a risk band, ` +
        `${share(ungraded.filter(legitimateBand), ungraded)} in a legitimate band. Neither counts as an ` +
        `error, because the model flags this capability without ruling on it.`,
    );
  }

  if (abuse.length === 0 || legit.length === 0) return;

  const abuseScores = abuse.map((row) => row.legitimacy);
  const legitScores = legit.map((row) => row.legitimacy);
  console.log(
    `\nSeparation between medians: ${distribution(legitScores).median - distribution(abuseScores).median} points`,
  );

  /*
   * Where the two graded distributions cross, which is the measurement the band boundaries are supposed
   * to sit on. Printed next to the configured floor so a drift between the two is visible rather than
   * inferred: bands chosen for roundness are exactly the failure this is here to catch.
   */
  const legitimateFloor =
    (DEFAULT_CONFIG.verdictBands.find((band) => band.verdict === 'unclear')?.maxScore ?? 0) + 1;

  console.log('\n=== Band boundary check: where do abuse and legitimate cross? ===');
  console.log('threshold  abuse below (recall)  legitimate at or above (specificity)  Youden J');
  let best = { threshold: 0, j: -Infinity };
  for (let threshold = 30; threshold <= 90; threshold += 1) {
    const recall = abuseScores.filter((value) => value < threshold).length / abuseScores.length;
    const specificity = legitScores.filter((value) => value >= threshold).length / legitScores.length;
    const j = recall + specificity - 1;
    if (j > best.j) best = { threshold, j };
    if (threshold % 4 === 0 || threshold === legitimateFloor) {
      console.log(
        `${String(threshold).padStart(9)}  ${`${Math.round(recall * 1000) / 10}%`.padStart(20)}  ` +
          `${`${Math.round(specificity * 1000) / 10}%`.padStart(36)}  ${j.toFixed(3)}` +
          `${threshold === legitimateFloor ? '   <- configured floor' : ''}`,
      );
    }
  }
  console.log(`\nBest separating threshold by Youden J: ${best.threshold} (J=${best.j.toFixed(3)})`);
  console.log(`Configured probably_legitimate floor: ${legitimateFloor}`);

  /*
   * The other three edges, which went unmeasured while only the crossover was swept.
   *
   * Reported as the share of each class that lands in the band, and deliberately not as the composition
   * of the band. Composition is the more natural question and the answer would be worthless here: this
   * holdout runs about twenty abuse domains to every legitimate one because it was assembled to exercise
   * the abuse half, so every band reads as mostly abuse and the number describes the sampling rather than
   * the boundary. Per-class rates do not move when the mix does.
   *
   * What each edge should be judged on is the claim its name makes. Almost no legitimate domain should
   * reach `high_risk`, and `established` should be hard for an abuse domain to reach.
   */
  console.log('\n=== The other band edges: what share of each class lands in each band? ===');
  console.log('band                     range   of abuse   of legitimate');
  const edges = DEFAULT_CONFIG.verdictBands;
  let lower = 0;
  for (const band of edges) {
    const inBand = (value: number) => value >= lower && value <= band.maxScore;
    const abuseIn = abuseScores.filter(inBand).length / abuseScores.length;
    const legitIn = legitScores.filter(inBand).length / legitScores.length;
    console.log(
      `${band.verdict.padEnd(22)} ${`${lower}-${band.maxScore}`.padStart(7)} ` +
        `${`${(abuseIn * 100).toFixed(1)}%`.padStart(10)}   ${`${(legitIn * 100).toFixed(1)}%`.padStart(13)}`,
    );
    lower = band.maxScore + 1;
  }

  /*
   * Where the two extreme edges would sit if placed on the claim rather than inherited. Both targets are
   * per-class rates for the reason above: a target expressed as a share of the band would move with the
   * next benchmark refresh even if the model had not changed at all.
   */
  const highRiskCeiling = edges.find((band) => band.verdict === 'high_risk')?.maxScore ?? 0;
  const establishedFloor = (edges.find((band) => band.verdict === 'probably_legitimate')?.maxScore ?? 0) + 1;

  let ceiling = 0;
  for (let target = 0; target <= 100; target += 1) {
    if (legitScores.filter((value) => value <= target).length / legitScores.length > 0.02) break;
    ceiling = target;
  }
  console.log(
    `\nhigh_risk could reach ${ceiling} before 2% of legitimate domains fall inside it (configured ${highRiskCeiling})`,
  );

  let floor = 100;
  for (let target = 100; target >= 0; target -= 1) {
    if (abuseScores.filter((value) => value >= target).length / abuseScores.length > 0.02) break;
    floor = target;
  }
  console.log(
    `established would need a floor of ${floor} to hold abuse below 2% of its class (configured ${establishedFloor})`,
  );
}
