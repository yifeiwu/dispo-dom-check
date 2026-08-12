/**
 * Verifies the weights and thresholds against a labelled holdout.
 *
 * The dataset is read at runtime from a local directory that is not committed, and nothing measured here
 * is written back into the source. No list, table or fingerprint in `lib/` is derived from it: its only
 * job is to answer whether the configured weights separate the labels and where the bands should sit.
 *
 * Only two of the three label groups are graded. Privacy and forwarding domains are reported alongside
 * them and counted as neither a hit nor a miss, because the model flags that capability deliberately
 * without condemning it; see `scripts/benchmark.mts`.
 *
 * This script never touches the network. It scores whatever `npm run audit -- --collect` has already
 * stored, replaying the responses that run recorded, which is what keeps a re-measurement both cheap and
 * honest: a weight or parser change is compared against the same observations as the run before rather
 * than against whatever the upstreams say this week. Collection lives in one place, in the audit.
 *
 * Run `npm run audit -- --reparse` after a collection and before this, or the two reports will disagree.
 * A collection stores the facts its deadlines allowed; replay answers instantly and gets further, so the
 * facts the audit scores are the collection's and the ones this script derives are the replay's.
 *
 * Usage: `npm run calibrate` for the whole store, `--limit 60` to spot-check a slice of each label.
 */
import { normaliseInput } from '../lib/domain';
import { analyze } from '../lib/analyze';
import { withHttpReplay } from '../lib/record';
import { DEFAULT_CONFIG, type Verdict } from '../lib/scoring/weights';
import { arg, pool } from './cli.mts';
import {
  BENCHMARK_DIR,
  describeGroups,
  isAbuse,
  isGraded,
  isLegitimate,
  loadBenchmark,
  orderedLabels,
  type Group,
  type Row,
} from './benchmark.mts';
import { describeAge, hasRaw, readRaw, readSharedRaw } from './raw-store.mts';

const benchmarkDir = arg('benchmark', BENCHMARK_DIR);
/** No cap by default: the whole store is what the reported figures are supposed to describe. */
const perLabel = Number(arg('limit', 'Infinity'));
const concurrency = Number(arg('concurrency', '6'));

/** Deterministic sampling, so a weight change is compared against the same domains as the run before. */
function sample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * step)]);
}

type Outcome = {
  domain: string;
  label: string;
  group: Group;
  legitimacy: number | null;
  confidence: number | null;
  verdict: Verdict | 'rejected' | 'out_of_scope';
  flags: string[];
  topDrivers: string[];
};

const sharedRaw = readSharedRaw();
let missed = 0;

async function evaluate(row: Row): Promise<Outcome> {
  const input = normaliseInput(row.domain);

  if (input.kind === 'rejected') {
    return { ...row, legitimacy: null, confidence: null, verdict: 'rejected', flags: [], topDrivers: [] };
  }
  if (input.kind === 'out_of_scope') {
    return { ...row, legitimacy: null, confidence: null, verdict: 'out_of_scope', flags: [], topDrivers: [] };
  }

  /*
   * Keyed on the submitted row rather than on the registrable domain it normalises to, because that is
   * the key collection wrote under. 126 rows in this holdout are subdomains of a registrable name, and
   * looking those up under the normalised name found nothing: the analysis then ran against an empty
   * transcript and scored the domain on no evidence at all, which is indistinguishable in the output
   * from a domain whose sources genuinely said nothing.
   */
  const { value: result, misses } = await withHttpReplay([readRaw(row.domain), sharedRaw], () =>
    analyze(input),
  );
  missed += misses.length;

  return {
    ...row,
    legitimacy: result.score.legitimacy,
    confidence: result.score.confidence,
    verdict: result.score.verdict,
    flags: result.score.flags,
    topDrivers: [...result.score.signals]
      .filter((signal) => signal.points !== 0)
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
      .slice(0, 3)
      .map((signal) => `${signal.id}(${signal.points})`),
  };
}

function stats(values: number[]): { n: number; median: number; mean: number; p10: number; p90: number } {
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

const loaded = loadBenchmark(benchmarkDir);
console.log(`Loaded ${loaded.length} labelled rows from ${benchmarkDir}/`);
console.log(`Groups: ${describeGroups(loaded)}`);

/**
 * Restricting the pool before sampling rather than after, so a `--limit` fills its per-label quota from
 * what is on disk instead of spending most of the quota on domains it then has to skip.
 */
const rows = loaded.filter((row) => hasRaw(row.domain));
console.log(`${rows.length} of these have stored responses (${describeGroups(rows)})`);
if (rows.length === 0) {
  console.log('Nothing to score. Run `npm run audit -- --collect` first.');
  process.exit(1);
}

const labels = orderedLabels(rows);
const selected = labels.flatMap(({ label }) => sample(rows.filter((row) => row.label === label), perLabel));
console.log(
  `Scoring ${selected.length} of them at concurrency ${concurrency}, replaying only ` +
    `(${describeAge(readSharedRaw())})\n`,
);

const { results: outcomes, failures } = await pool(selected, concurrency, evaluate, 'scored');

if (failures.length > 0) {
  console.log(`${failures.length} of ${selected.length} domains threw and are missing from every figure below:`);
  for (const failure of failures.slice(0, 5)) console.log(`  ${failure}`);
}
if (missed > 0) {
  console.log(
    `${missed} requests had no recorded response. Usually these were still in flight when a collector's ` +
      `deadline abandoned them; if instead the collectors now request something new, delete those ` +
      `transcripts and re-run \`npm run audit -- --collect\`.`,
  );
}

/** Marks the group that is reported but never graded, so no reader mistakes a row for an error rate. */
const note = (group: Group) => (group === 'privacy' ? '  (not graded)' : '');
const inLabel = (label: string) => outcomes.filter((outcome) => outcome.label === label);

console.log('\n=== Score distribution by label (legitimacy, higher is more legitimate) ===');
for (const { label, group } of labels) {
  const withScore = inLabel(label).filter((outcome) => outcome.legitimacy !== null);
  const distribution = stats(withScore.map((outcome) => outcome.legitimacy as number));
  const confidence = stats(withScore.map((outcome) => outcome.confidence as number));
  console.log(
    `${label.padEnd(14)} n=${String(distribution.n).padStart(3)}  median=${String(distribution.median).padStart(3)}  mean=${String(distribution.mean).padStart(5)}  p10=${String(distribution.p10).padStart(3)}  p90=${String(distribution.p90).padStart(3)}  confidence median=${confidence.median}${note(group)}`,
  );
}

console.log('\n=== Verdict distribution by label ===');
for (const { label, group } of labels) {
  const counts = new Map<string, number>();
  for (const outcome of inLabel(label)) counts.set(outcome.verdict, (counts.get(outcome.verdict) ?? 0) + 1);
  const rendered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([verdict, count]) => `${verdict}=${count}`)
    .join(' ');
  console.log(`${label.padEnd(14)} ${rendered}${note(group)}`);
}

console.log('\n=== Flag hit rate by label ===');
for (const { label, group } of labels) {
  const inGroup = inLabel(label);
  const counts = new Map<string, number>();
  for (const outcome of inGroup) {
    for (const flag of outcome.flags) counts.set(flag, (counts.get(flag) ?? 0) + 1);
  }
  const rendered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([flag, count]) => `${flag}=${Math.round((count / inGroup.length) * 100)}%`)
    .join(' ');
  console.log(`${label.padEnd(14)} ${rendered || 'none'}${note(group)}`);
}

const scored = outcomes.filter((outcome) => outcome.legitimacy !== null);
const abuse = scored.filter(isAbuse);
const legit = scored.filter(isLegitimate);
const ungraded = scored.filter((outcome) => !isGraded(outcome));

/** The score at which a verdict first stops being negative, which is the boundary the bands turn on. */
const legitimateFloor =
  (DEFAULT_CONFIG.verdictBands.find((band) => band.verdict === 'unclear')?.maxScore ?? 0) + 1;

const riskBand = (outcome: Outcome) => outcome.verdict === 'high_risk' || outcome.verdict === 'suspicious';
const legitimateBand = (outcome: Outcome) =>
  outcome.verdict === 'probably_legitimate' || outcome.verdict === 'established';
const share = (part: Outcome[], whole: Outcome[]) =>
  whole.length === 0 ? '-' : `${Math.round((part.length / whole.length) * 100)}%`;

/**
 * The failures worth acting on. A legitimate domain scored as risky is the expensive error, because it
 * blocks a real user, so those are listed with their drivers to show which weight caused it.
 */
console.log('\n=== False positives: legitimate domains landing in a risk band ===');
const falsePositives = legit.filter(riskBand);
console.log(
  falsePositives.length === 0 ? 'none' : `${falsePositives.length} of ${legit.length} (${share(falsePositives, legit)})`,
);
for (const outcome of falsePositives) {
  console.log(`  ${outcome.legitimacy}  ${outcome.verdict.padEnd(12)} ${outcome.topDrivers.join(' ')}`);
}

console.log('\n=== False negatives: abuse domains landing in a legitimate band ===');
const falseNegatives = abuse.filter(legitimateBand);
console.log(
  falseNegatives.length === 0 ? 'none' : `${falseNegatives.length} of ${abuse.length} (${share(falseNegatives, abuse)})`,
);
for (const outcome of falseNegatives.slice(0, 15)) {
  console.log(`  ${outcome.legitimacy}  ${outcome.verdict.padEnd(20)} ${outcome.topDrivers.join(' ')}`);
}

/**
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

if (abuse.length && legit.length) {
  const abuseScores = abuse.map((outcome) => outcome.legitimacy as number);
  const legitScores = legit.map((outcome) => outcome.legitimacy as number);
  console.log(`\nSeparation between medians: ${stats(legitScores).median - stats(abuseScores).median} points`);

  /**
   * Where the two graded distributions cross, which is the measurement the band boundaries are supposed
   * to sit on. Printed next to the configured floor so a drift between the two is visible rather than
   * inferred: bands chosen for roundness are exactly the failure this is here to catch.
   */
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

  /**
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

  /**
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
