/**
 * Measures what each signal and combination is actually worth against the labelled holdout.
 *
 * Calibration answers "do the weights separate the labels". This answers the narrower and more
 * uncomfortable question: does each individual heuristic earn its place, or is it dead weight, noise, or
 * pointing the wrong way. Nothing here writes back into `lib/`; it only reports.
 *
 * Three phases, because collection is the expensive part:
 *
 *   npm run audit -- --collect            # probes the network once, caching facts and raw responses
 *   npm run audit -- --reparse            # rebuilds facts from the stored responses, no network
 *   npm run audit                          # re-scores the cached facts offline, no network
 *
 * Facts are cached rather than scores, so every ablation is a pure re-score of the same observations.
 * The responses behind those facts are cached too, so a change to a *collector* is answered by
 * `--reparse` rather than by probing the holdout again: see `scripts/raw-store.mts`.
 *
 * `--group` narrows every phase to named groups, which is how the cache is topped up for one group
 * without probing the others: `npm run audit -- --collect --group legitimate`.
 *
 * Usage: npm run audit -- --collect --concurrency 8
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normaliseInput } from '../lib/domain';
import { analyze } from '../lib/analyze';
import type { DomainFacts } from '../lib/facts';
import { sharedTranscript, withHttpRecording, withHttpReplay } from '../lib/record';
import { score } from '../lib/scoring/score';
import { SIGNALS } from '../lib/scoring/signals';
import { COMBINATIONS } from '../lib/scoring/combinations';
import { DEFAULT_CONFIG, type ScoringConfig } from '../lib/scoring/weights';
import { arg, pool, flag } from './cli.mts';
import {
  BENCHMARK_DIR,
  describeGroups,
  filterGroups,
  isAbuse,
  isGraded,
  isLegitimate,
  loadBenchmark,
  type Group,
  type Row,
} from './benchmark.mts';
import {
  CACHE_DIR,
  RAW_DIR,
  describeAge,
  hasRaw,
  mergeSharedRaw,
  readRaw,
  readSharedRaw,
  safeName,
  writeRaw,
} from './raw-store.mts';

type Cached = { domain: string; label: string; group: Group; facts: DomainFacts };

const benchmarkDir = arg('benchmark', BENCHMARK_DIR);
const groups = arg('group', '');
const concurrency = Number(arg('concurrency', '8'));
const bootstrapDraws = Number(arg('bootstrap', '400'));
/**
 * How many independent operators a signal must be seen by before the run is willing to call it flat.
 *
 * Counted in families rather than domains, because the question a removal turns on is how much
 * independent evidence there is, and one operator's four hundred names is one operator.
 */
const familyGate = Number(arg('gate', '10'));

/**
 * One operator's generated names collapse to a single key: `mail01.example` through `mail99.example`
 * are one family. The abuse half is full of them and they are not independent observations, so every
 * figure below weights a family to a total of one and every interval resamples families.
 */
function familyKey(domain: string): string {
  const parts = domain.split('.');
  const label = parts[0];
  const suffix = parts.slice(1).join('.');
  const stripped = label.replace(/\d+/g, '#');
  return `${stripped}|${suffix}`;
}

// ---------------------------------------------------------------------------------------------
// Phase one: collection, cached per domain so a re-run costs nothing
// ---------------------------------------------------------------------------------------------

const cachePathFor = (domain: string) => join(CACHE_DIR, `${safeName(domain)}.json`);

const writeFacts = (row: Row, facts: DomainFacts) =>
  writeFileSync(cachePathFor(row.domain), JSON.stringify({ domain: row.domain, label: row.label, facts }));

/**
 * A domain is only considered collected once both halves are on disk. The facts alone were enough while
 * they were all that was stored, but a domain with facts and no transcript is exactly the one that would
 * force a refetch later.
 *
 * A run is therefore resumable, and that is also how a starved source is recovered: delete the cache
 * entries whose stored facts show the source timing out, and re-run `--collect` at a lower concurrency.
 */
const isCollected = (domain: string) => existsSync(cachePathFor(domain)) && hasRaw(domain);

async function collect(rows: Row[]): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const pending = rows.filter((row) => !isCollected(row.domain));
  console.log(`${rows.length} rows, ${rows.length - pending.length} already cached, ${pending.length} to probe`);

  let empty = 0;
  /**
   * Throttling has to be caught while it is happening, not inferred afterwards from a thin column.
   *
   * A large abuse collection concentrates on a handful of suffixes and therefore on a handful of registry
   * servers. The registration record carries the heaviest confidence weight and the model's strongest
   * signal, so a throttled run does not merely go slowly: it produces a cache in which age is missing for
   * reasons that have nothing to do with the domains, and every measurement taken from it is wrong.
   *
   * Both registration protocols are watched, and port 43 is the likelier of the two to trip. Its limits
   * are tighter than RDAP's, they are enforced per source address, and a run concentrated on one ccTLD is
   * hitting a single registry from a single address for its whole duration.
   */
  const throttled = new Map<string, number>();
  const answered = new Map<string, number>();
  const warned = new Set<string>();

  const { failures } = await pool(
    pending,
    concurrency,
    async (row) => {
      const input = normaliseInput(row.domain);
      if (input.kind !== 'ok') {
        writeFileSync(
          cachePathFor(row.domain),
          JSON.stringify({ domain: row.domain, label: row.label, skipped: input.kind }),
        );
        // A transcript of nothing, so the domain counts as collected rather than being re-probed forever.
        writeRaw(row.domain, { recordedAt: new Date().toISOString(), exchanges: [] });
        return;
      }
      const { value, transcript } = await withHttpRecording(() => analyze(input));
      if (transcript.exchanges.length === 0) empty += 1;
      writeRaw(row.domain, transcript);
      writeFacts(row, value.facts);

      for (const source of value.facts.sources) {
        answered.set(source.source, (answered.get(source.source) ?? 0) + 1);
        if (source.status === 'rate_limited') {
          throttled.set(source.source, (throttled.get(source.source) ?? 0) + 1);
        }
      }
      for (const source of ['rdap', 'whois']) {
        const seen = answered.get(source) ?? 0;
        const limited = throttled.get(source) ?? 0;
        if (warned.has(source) || seen < 200 || limited / seen <= 0.02) continue;
        warned.add(source);
        process.stderr.write(
          `\n  ${source.toUpperCase()} is rate limiting: ${limited} of ${seen} so far. Consider stopping ` +
            `and re-running with a lower --concurrency; the run is resumable and will skip what is stored.\n`,
        );
      }
    },
    'probed',
  );

  mergeSharedRaw(sharedTranscript());
  console.log(`Collection complete`);
  if (failures.length > 0) {
    console.log(`${failures.length} domains threw and were not stored: ${failures[0]}`);
  }

  for (const [source, count] of [...throttled].sort((a, b) => b[1] - a[1])) {
    const seen = answered.get(source) ?? 0;
    console.log(`  ${source} was rate limited on ${count} of ${seen} domains (${pct(count / seen)})`);
  }

  /**
   * Every analysable domain queries DNS at minimum, so an empty transcript means the recorder saw
   * nothing rather than that there was nothing to see. Worth failing on: the run would otherwise look
   * successful and leave a cache that cannot be re-parsed.
   */
  if (empty > 0) {
    console.error(`\n${empty} domains recorded no responses at all. The recorder is not observing the`);
    console.error(`collectors, so this cache cannot be re-parsed. Fix before trusting the run.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------------------------
// Phase two: re-parse, which is why the responses are kept
// ---------------------------------------------------------------------------------------------

/**
 * Rebuilds the facts by running the current collectors against the stored responses. This is the answer
 * to a parser change: no network, and every domain sees exactly what it saw during collection.
 *
 * Two things a replayed run cannot recover, both reported rather than hidden. A request the new code
 * makes that the recording never saw has no answer and is counted as a miss. And anything measured
 * against the clock, registration age above all, is computed from today rather than from the day the
 * response was captured, so an old transcript ages its domains along with it.
 */
async function reparse(rows: Row[]): Promise<void> {
  const shared = readSharedRaw();
  const available = rows.filter((row) => hasRaw(row.domain));
  const oldest = available
    .map((row) => readRaw(row.domain)?.recordedAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];

  console.log(
    `${available.length} of ${rows.length} domains have stored responses` +
      (oldest ? `, oldest ${describeAge({ recordedAt: oldest, exchanges: [] })}` : ''),
  );
  if (available.length === 0) {
    console.log('Nothing to re-parse. Run with --collect first.');
    return;
  }

  let missed = 0;
  const missedDomains: string[] = [];

  await pool(
    available,
    concurrency,
    async (row) => {
      const input = normaliseInput(row.domain);
      if (input.kind !== 'ok') return;
      const transcript = readRaw(row.domain);
      const { value, misses } = await withHttpReplay([transcript, shared], () => analyze(input));
      if (misses.length > 0) {
        missed += misses.length;
        if (missedDomains.length < 5) missedDomains.push(row.domain);
      }
      writeFacts(row, value.facts);
    },
    're-parsed',
  );

  console.log(`Re-parse complete`);
  if (missed > 0) {
    console.log(
      `${missed} requests had no recorded response (e.g. ${missedDomains.join(', ')}). Usually these were ` +
        `still in flight when a collector's deadline abandoned them, so nothing came back to record; a ` +
        `replayed run answers instantly and reaches them. If instead the collectors have learned to ` +
        `request something new, delete those transcripts from ${RAW_DIR} and re-run --collect.`,
    );
  }
}

/**
 * Facts are cached per domain and outlive any one benchmark, so the label is taken from the files being
 * audited rather than from the cache entry. Two datasets can disagree about a domain, and the run must
 * reflect the one it was pointed at.
 */
function loadCache(rows: Row[]): Cached[] {
  mkdirSync(CACHE_DIR, { recursive: true });
  const wanted = new Map(rows.map((row) => [row.domain, row]));
  const entries: Cached[] = [];
  for (const file of readdirSync(CACHE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf8'));
    const row = wanted.get(parsed.domain);
    if (!parsed.facts || row === undefined) continue;
    entries.push({ ...row, facts: parsed.facts });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;

/**
 * Wilson score interval, which is the right binomial interval at the counts this report deals in.
 *
 * The normal approximation collapses when a signal fires a handful of times or fires unanimously, and
 * those are precisely the cases the tiering has to rule on. Wilson stays inside [0,1] and does not
 * degenerate to a zero-width interval at p=0 or p=1, so "fired on 9 domains, all abuse" comes out as the
 * weak evidence it is rather than as certainty.
 */
function wilson(successes: number, trials: number, z = 1.96): [number, number] {
  if (trials === 0) return [0, 1];
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return [Math.max(0, (centre - spread) / denominator), Math.min(1, (centre + spread) / denominator)];
}

/**
 * Score histograms, exploiting the fact that `legitimacy` is a rounded integer in [0,100].
 *
 * Every measurement below is some AUC over a resampled cohort, thousands of times over, and the
 * rank-based form is O(n log n) with an allocation per call. Bucketing by score makes each AUC a linear
 * pass and a 101-bin sweep, which is what makes a cluster bootstrap over every signal affordable.
 */
const SCORE_BINS = 101;
const abuseHistogram = new Float64Array(SCORE_BINS);
const legitHistogram = new Float64Array(SCORE_BINS);

function aucFromHistograms(abuseMass: number, legitMass: number): number {
  if (abuseMass <= 0 || legitMass <= 0) return NaN;
  // P(a legitimate domain scores above an abuse one) plus half the ties, which is the quantity averaged
  // ranks compute when ranking by risk. Ties are heavy here, since the scores are coarse integers.
  let above = legitMass;
  let total = 0;
  for (let score = 0; score < SCORE_BINS; score += 1) {
    above -= legitHistogram[score];
    total += abuseHistogram[score] * (above + 0.5 * legitHistogram[score]);
  }
  return total / (abuseMass * legitMass);
}

/**
 * Weighting each family to a total of one keeps every domain in the run while giving a family of 400 no
 * more say than a family of 1. Resampling *families* rather than domains then gives an interval that
 * reflects how few independent operators some signals have actually been seen by.
 */
type Family = { members: number[]; abuse: boolean; legit: boolean };

function buildFamilies(entries: Cached[]): { families: Family[]; familyOf: Int32Array; weights: Float64Array } {
  const index = new Map<string, number>();
  const families: Family[] = [];
  const familyOf = new Int32Array(entries.length);

  entries.forEach((entry, position) => {
    const bucket = isAbuse(entry) ? 'a' : isLegitimate(entry) ? 'l' : 'p';
    const key = `${bucket}|${familyKey(entry.domain)}`;
    let at = index.get(key);
    if (at === undefined) {
      at = families.length;
      index.set(key, at);
      families.push({ members: [], abuse: isAbuse(entry), legit: isLegitimate(entry) });
    }
    families[at].members.push(position);
    familyOf[position] = at;
  });

  const weights = new Float64Array(entries.length);
  for (const family of families) {
    for (const member of family.members) weights[member] = 1 / family.members.length;
  }
  return { families, familyOf, weights };
}

/** Deterministic generator, so a re-run compares against the same resamples as the run before. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return NaN;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[at];
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const loaded = loadBenchmark(benchmarkDir);
const rows = groups ? filterGroups(loaded, groups) : loaded;
if (groups) console.log(`Restricted to ${groups}: ${describeGroups(rows)}`);

if (flag('collect')) await collect(rows);
if (flag('reparse')) await reparse(rows);

const cached = loadCache(rows);
if (cached.length === 0) {
  console.log('No cached facts. Run with --collect first.');
  process.exit(1);
}

/**
 * Positive class is abuse, negative is legitimate. Privacy sits out of the headline metric on purpose:
 * the model deliberately flags forwarders without condemning them, so scoring them as either class would
 * measure a policy choice rather than an error. Their firing rates are still printed, one column over.
 */
type Scored = { entry: Cached; legitimacy: number; verdict: string; abuse: boolean; legit: boolean };

function scoreAll(exclude?: ReadonlySet<string>): Scored[] {
  return cached.map((entry) => {
    const result = score(entry.facts, DEFAULT_CONFIG, exclude);
    return {
      entry,
      legitimacy: result.legitimacy,
      verdict: result.verdict,
      abuse: isAbuse(entry),
      legit: isLegitimate(entry),
    };
  });
}

const { families, familyOf, weights } = buildFamilies(cached);
const abuseFamilies = families.map((family, at) => (family.abuse ? at : -1)).filter((at) => at >= 0);
const legitFamilies = families.map((family, at) => (family.legit ? at : -1)).filter((at) => at >= 0);

/** Scratch arrays reused across every resample, since this runs some hundreds of thousands of times. */
function weightedAucOver(scores: Int32Array, abuseDraw: Int32Array, legitDraw: Int32Array): number {
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
  return aucFromHistograms(abuseMass, legitMass);
}

const allAbuseDraw = Int32Array.from(abuseFamilies);
const allLegitDraw = Int32Array.from(legitFamilies);
const scoresOf = (rowsIn: Scored[]) => Int32Array.from(rowsIn, (row) => row.legitimacy);

/**
 * The resamples, drawn once and reused for every ablation.
 *
 * Common random numbers across signals is deliberate: the quantity of interest is a difference of two
 * AUCs on the same cohort, so pairing the resamples removes the cohort-to-cohort variance that both
 * sides share and leaves the variance of the difference, which is the thing being estimated.
 */
const random = mulberry32(0x5eed);
const draws: { abuse: Int32Array; legit: Int32Array }[] = [];
for (let draw = 0; draw < bootstrapDraws; draw += 1) {
  const abuseDraw = new Int32Array(abuseFamilies.length);
  const legitDraw = new Int32Array(legitFamilies.length);
  for (let i = 0; i < abuseDraw.length; i += 1) {
    abuseDraw[i] = abuseFamilies[Math.floor(random() * abuseFamilies.length)];
  }
  for (let i = 0; i < legitDraw.length; i += 1) {
    legitDraw[i] = legitFamilies[Math.floor(random() * legitFamilies.length)];
  }
  draws.push({ abuse: abuseDraw, legit: legitDraw });
}

const baseline = scoreAll();
const baselineScores = scoresOf(baseline);
const baselineAuc = weightedAucOver(baselineScores, allAbuseDraw, allLegitDraw);
const baselinePerDraw = draws.map((draw) => weightedAucOver(baselineScores, draw.abuse, draw.legit));

/**
 * Removing a signal is only interesting if it moves a verdict. AUC is a ranking measure and the product
 * ships bands, so a signal can be worth nothing to the ranking and still be holding domains on the right
 * side of a boundary, or the reverse.
 */
const ACTIONABLE = new Set(['high_risk', 'suspicious']);
const LEGITIMATE_BAND = new Set(['probably_legitimate', 'established']);
function bandErrors(rowsIn: Scored[]): { falsePositives: number; falseNegatives: number } {
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const row of rowsIn) {
    if (row.legit && ACTIONABLE.has(row.verdict)) falsePositives += 1;
    if (row.abuse && LEGITIMATE_BAND.has(row.verdict)) falseNegatives += 1;
  }
  return { falsePositives, falseNegatives };
}
const baselineBands = bandErrors(baseline);

function deltaAucCi(withoutScores: Int32Array): { point: number; lo: number; hi: number } {
  const point = baselineAuc - weightedAucOver(withoutScores, allAbuseDraw, allLegitDraw);
  const deltas = draws
    .map((draw, at) => baselinePerDraw[at] - weightedAucOver(withoutScores, draw.abuse, draw.legit))
    .sort((a, b) => a - b);
  return { point, lo: percentile(deltas, 0.025), hi: percentile(deltas, 0.975) };
}

const abuseTotal = cached.filter(isAbuse).length;
const legitTotal = cached.filter(isLegitimate).length;
const privacyTotal = cached.filter((entry) => !isGraded(entry)).length;

const counts = new Map<string, number>();
for (const entry of cached) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);

console.log(`\nScored ${cached.length} domains from cache: ${[...counts].map(([l, c]) => `${l}=${c}`).join(' ')}`);
console.log(
  `${abuseFamilies.length} abuse families and ${legitFamilies.length} legitimate families. Every statistic ` +
    `below weights each family to a total of one, and every interval resamples families rather than ` +
    `domains, because one operator's ${Math.max(...families.map((f) => f.members.length))} generated names ` +
    `are not that many independent observations.`,
);
console.log(
  `Baseline AUC (abuse vs legitimate, ranked by risk): ${baselineAuc.toFixed(3)} family-weighted, over ` +
    `${abuseTotal} abuse and ${legitTotal} legitimate; ${privacyTotal} privacy domains are not graded`,
);
console.log(
  `Baseline band errors: ${baselineBands.falsePositives} legitimate domains in an actionable band ` +
    `(${pct(baselineBands.falsePositives / Math.max(legitTotal, 1))}), ${baselineBands.falseNegatives} abuse ` +
    `domains in a legitimate band (${pct(baselineBands.falseNegatives / Math.max(abuseTotal, 1))})`,
);
console.log(`Intervals are 95% from ${bootstrapDraws} cluster-bootstrap resamples.`);

// Per-signal firing behaviour, computed from a single pass of the full scorer.
type Stat = {
  id: string;
  dimension: string;
  applicable: { abuse: number; legit: number; privacy: number };
  fired: { abuse: number; legit: number; privacy: number };
  /** Family-weighted firing mass, so a large generated family counts once. */
  mass: { abuse: number; legit: number; privacy: number };
  /** Distinct families the signal was seen by, which is the count the rarity gate reads. */
  families: { abuse: Set<number>; legit: Set<number>; privacy: Set<number> };
  /**
   * Points contributed per domain of the class, counting a domain the signal skipped as zero. Averaging
   * only over the domains a signal applied to would hide how often it applies, and would report a tiered
   * signal that swings from -30 to +20 as though the two were the same event. Weighted by family for the
   * same reason every other figure here is.
   */
  points: { abuse: number; legit: number };
  /** Per-domain firing, kept so identical predicates can be found mechanically rather than by reading. */
  vector: Uint8Array;
};

function emptyStat(id: string, dimension: string): Stat {
  return {
    id,
    dimension,
    applicable: { abuse: 0, legit: 0, privacy: 0 },
    fired: { abuse: 0, legit: 0, privacy: 0 },
    mass: { abuse: 0, legit: 0, privacy: 0 },
    families: { abuse: new Set(), legit: new Set(), privacy: new Set() },
    points: { abuse: 0, legit: 0 },
    vector: new Uint8Array(cached.length),
  };
}

const stats = new Map<string, Stat>();
for (const definition of SIGNALS) stats.set(definition.id, emptyStat(definition.id, definition.dimension));

const comboFired = new Map<string, { abuse: number; legit: number; privacy: number }>();
for (const combination of COMBINATIONS) comboFired.set(combination.id, { abuse: 0, legit: 0, privacy: 0 });

/** Family-weighted totals per class, the denominators every rate below is expressed against. */
const classMass = { abuse: 0, legit: 0, privacy: 0 };
const classFamilies = { abuse: new Set<number>(), legit: new Set<number>(), privacy: new Set<number>() };

cached.forEach((entry, position) => {
  const result = score(entry.facts);
  const bucket = isAbuse(entry) ? 'abuse' : isLegitimate(entry) ? 'legit' : 'privacy';
  const weight = weights[position];
  const family = familyOf[position];
  classMass[bucket] += weight;
  classFamilies[bucket].add(family);
  const contributed = new Map(result.signals.map((signal) => [signal.id, signal.points]));

  for (const definition of SIGNALS) {
    const stat = stats.get(definition.id)!;
    const points = contributed.get(definition.id);
    if (points !== undefined) {
      stat.applicable[bucket] += 1;
      if (points !== 0) {
        stat.fired[bucket] += 1;
        stat.mass[bucket] += weight;
        stat.families[bucket].add(family);
        stat.vector[position] = 1;
      }
    }
    if (bucket !== 'privacy') stat.points[bucket] += (points ?? 0) * weight;
  }
  for (const combination of result.combinations) {
    const record = comboFired.get(combination.id);
    if (record) record[bucket] += 1;
  }
});

/**
 * Which collector each signal reads from, so a signal starved of data is never mistaken for a signal
 * that had data and found nothing. Those are opposite conclusions: one is a sourcing problem, the other
 * says the heuristic is wrong.
 */
const SIGNAL_SOURCES: Record<string, string[]> = {
  'signup.temp_mail': ['signup'],
  'signup.free_routing': ['signup'],
  'signup.forwarder': ['signup'],
  'signup.paid_tenant': ['signup'],
  'economics.first_year_price': ['pricing'],
  'economics.renewal_ratio': ['pricing', 'rdap', 'whois'],
  'economics.unpriced_suffix': ['pricing'],
  'age.first_seen': ['rdap', 'whois'],
  'age.single_year_term': ['rdap', 'whois'],
  'age.expiring_unrenewed': ['rdap', 'whois'],
  'age.registry_hold': ['rdap', 'whois'],
  'age.pending_delete': ['rdap', 'whois'],
  'mail.spf_present': ['mail'],
  'mail.dmarc_policy': ['mail'],
  'mail.strict_alignment': ['mail'],
  'mail.subdomain_policy': ['mail'],
  'mail.commercial_rua': ['mail'],
  'mail.paid_spf_senders': ['mail'],
  'mail.spf_permit_all': ['mail'],
  'mail.no_spf_with_site': ['mail', 'site'],
  'configuration.record_breadth': ['dns'],
  'configuration.title_matches_domain': ['site'],
  'footprint.saas_vendors': ['mail'],
  'footprint.dkim': ['mail'],
  'footprint.dnssec': ['dns'],
  'site.substantive_content': ['site'],
  'site.parked': ['site'],
  'site.no_address_when_young': ['dns', 'rdap', 'whois'],
  'name.template_digits': [],
  'name.vetted_suffix': [],
};

const sourceOk = new Map<string, number>();
for (const entry of cached) {
  for (const source of entry.facts.sources) {
    if (source.status === 'ok') sourceOk.set(source.source, (sourceOk.get(source.source) ?? 0) + 1);
  }
}
/** A signal reading several sources needs only one of them, so availability is the best of the set. */
function availability(id: string): number {
  const sources = SIGNAL_SOURCES[id] ?? [];
  if (sources.length === 0) return 1;
  return Math.max(...sources.map((source) => (sourceOk.get(source) ?? 0) / cached.length));
}

/**
 * Every signal must be listed, including with an empty array for the ones computed locally. A signal
 * missing from the map silently reports full data availability, which is the one reading that turns
 * "this source never answered" into "this heuristic found nothing" — the exact confusion the map exists
 * to prevent.
 */
const unmapped = SIGNALS.filter((definition) => !(definition.id in SIGNAL_SOURCES)).map((d) => d.id);
if (unmapped.length > 0) {
  console.error(`SIGNAL_SOURCES is missing ${unmapped.join(', ')}. Add them before trusting the data column.`);
  process.exit(1);
}

/**
 * Ablation: the only measure that accounts for clamps, discounts and correlation with other signals.
 *
 * Each one carries a bootstrap interval and the change in band errors alongside the point estimate,
 * because the three answer different questions and a removal needs all three. The point estimate says
 * which way the signal pushes; the interval says whether the run can tell that from nothing; the band
 * delta says whether any of it reaches a verdict a consumer would see.
 */
type Ablation = {
  id: string;
  deltaAuc: number;
  lo: number;
  hi: number;
  falsePositives: number;
  falseNegatives: number;
};

const ablations: Ablation[] = [];
for (const id of [...SIGNALS.map((s) => s.id), ...COMBINATIONS.map((c) => c.id)]) {
  const without = scoreAll(new Set([id]));
  const interval = deltaAucCi(scoresOf(without));
  const bands = bandErrors(without);
  ablations.push({
    id,
    deltaAuc: interval.point,
    lo: interval.lo,
    hi: interval.hi,
    falsePositives: bands.falsePositives - baselineBands.falsePositives,
    falseNegatives: bands.falseNegatives - baselineBands.falseNegatives,
  });
}
const ablationById = new Map(ablations.map((entry) => [entry.id, entry]));

/**
 * Identical predicates, found by comparing what actually fired rather than by reading the source.
 *
 * Two signals scoring the same fact in two dimensions is invisible to every other measurement here:
 * each looks individually reasonable, and the per-dimension clamps that are supposed to stop a single
 * fact dominating are both satisfied, because the fact is being counted in two of them.
 */
const duplicates: { a: string; b: string; agreement: number }[] = [];
const withFirings = SIGNALS.filter((definition) => {
  const stat = stats.get(definition.id)!;
  return stat.fired.abuse + stat.fired.legit + stat.fired.privacy > 0;
});
for (let i = 0; i < withFirings.length; i += 1) {
  for (let j = i + 1; j < withFirings.length; j += 1) {
    const left = stats.get(withFirings[i].id)!.vector;
    const right = stats.get(withFirings[j].id)!.vector;
    let both = 0;
    let either = 0;
    for (let at = 0; at < left.length; at += 1) {
      if (left[at] || right[at]) {
        either += 1;
        if (left[at] && right[at]) both += 1;
      }
    }
    if (either > 0 && both / either >= 0.99) {
      duplicates.push({ a: withFirings[i].id, b: withFirings[j].id, agreement: both / either });
    }
  }
}
const duplicateOf = new Map<string, string>();
for (const pair of duplicates) {
  // The lower-weighted half of the pair is the one reported as redundant, since folding a fact into the
  // signal that already carries most of it changes the fewest scores.
  duplicateOf.set(pair.b, pair.a);
}

/**
 * The tier rule, fixed before the numbers were read.
 *
 * It removes only on positive evidence of no value, which mirrors the model's own governing rule about
 * penalising only on positive evidence. The distinction it exists to draw is between a signal that was
 * measured and found worthless and one that was never measured at all: the second is a statement about
 * the sample, and deleting on it would be fitting the holdout.
 */
const KEEP_UNMEASURED = 'KEEP unmeasured, too few families';
const KEEP_UNGRADED = 'KEEP target population is ungraded';

type Judged = {
  id: string;
  separation: number;
  delta: number;
  lo: number;
  hi: number;
  families: number;
  liftLo: number;
  liftHi: number;
  verdict: string;
  line: string;
};
const judged: Judged[] = [];

const gradedFamilies = classFamilies.abuse.size + classFamilies.legit.size;
const baseAbuseShare = gradedFamilies > 0 ? classFamilies.abuse.size / gradedFamilies : 0;

console.log(`\n=== Signals ===`);
console.log(
  `Rates are family-weighted. 'fam' is how many independent operators the signal was seen by, which is ` +
    `what the rarity gate reads (currently ${familyGate}). 'lift' is the abuse share among families it ` +
    `fired on, over the ${pct(baseAbuseShare)} base rate, with a Wilson interval; an interval spanning 1.00 ` +
    `means the signal selects no better than picking at random.`,
);
console.log(
  `${'signal'.padEnd(36)} ${'data'.padStart(5)} ${'abuse'.padStart(6)} ${'legit'.padStart(6)} ${'priv'.padStart(5)} ${'fam'.padStart(5)} ${'sep'.padStart(7)} ${'lift'.padStart(16)} ${'ΔAUC'.padStart(7)} ${'95% CI'.padStart(17)} ${'band'.padStart(9)}  tier`,
);

for (const definition of SIGNALS) {
  const stat = stats.get(definition.id)!;
  const abuseRate = classMass.abuse ? stat.mass.abuse / classMass.abuse : 0;
  const legitRate = classMass.legit ? stat.mass.legit / classMass.legit : 0;
  const privacyRate = classMass.privacy ? stat.mass.privacy / classMass.privacy : 0;
  const ablation = ablationById.get(definition.id)!;

  /**
   * Separation is the expected points a legitimate domain receives from this signal minus the expected
   * points an abuse domain receives. Positive means the signal pushes the two classes apart in the
   * direction the model intends, whatever mix of positive and negative tiers it uses to get there.
   */
  const separation =
    (classMass.legit ? stat.points.legit / classMass.legit : 0) -
    (classMass.abuse ? stat.points.abuse / classMass.abuse : 0);

  const data = availability(definition.id);
  const abuseFams = stat.families.abuse.size;
  const legitFams = stat.families.legit.size;
  const firedFamilies = abuseFams + legitFams;
  const [shareLo, shareHi] = wilson(abuseFams, firedFamilies);
  const liftLo = baseAbuseShare > 0 ? shareLo / baseAbuseShare : 0;
  const liftHi = baseAbuseShare > 0 ? shareHi / baseAbuseShare : 0;

  const applies = stat.applicable.abuse + stat.applicable.legit + stat.applicable.privacy;
  const fires = stat.fired.abuse + stat.fired.legit + stat.fired.privacy;
  const movesBands = ablation.falsePositives !== 0 || ablation.falseNegatives !== 0;
  /**
   * A signal whose firings are overwhelmingly in the ungraded privacy group cannot be judged by any
   * metric on this page, because the graded classes are the only thing they measure. That is a property
   * of the grading policy rather than of the signal, and the model flags forwarders on purpose.
   */
  const privacyTargeted =
    stat.families.privacy.size > 0 && stat.families.privacy.size >= firedFamilies;

  let verdict: string;
  if (applies === 0 && data < 0.05) verdict = 'KEEP no data, source never answered';
  else if (fires === 0 && applies > 0) verdict = 'KEEP scores zero by design';
  else if (duplicateOf.has(definition.id)) verdict = `REMOVE redundant with ${duplicateOf.get(definition.id)}`;
  else if (firedFamilies >= familyGate && separation < 0) verdict = 'REMOVE backwards';
  else if (ablation.hi < 0) verdict = 'REMOVE measurably harmful';
  else if (privacyTargeted) verdict = KEEP_UNGRADED;
  else if (firedFamilies < familyGate) verdict = KEEP_UNMEASURED;
  else if (liftLo <= 1 && liftHi >= 1 && ablation.lo <= 0 && ablation.hi >= 0 && !movesBands) {
    verdict = 'REMOVE flat';
  } else if (ablation.lo > 0) verdict = 'KEEP measurably useful';
  else verdict = 'KEEP';

  /**
   * A removal has to survive the metric the product actually ships.
   *
   * Everything above this line is computed from AUC, which ranks. The service emits a band, and the two
   * can disagree sharply: a signal firing on slightly more legitimate domains than abuse ones looks
   * backwards by rate while still being the thing holding a few dozen abuse domains on the correct side
   * of a boundary, because what matters at a boundary is which domains a penalty reaches rather than how
   * many. Where the ranking says remove and the bands say the removal costs more verdicts than it fixes,
   * the bands win and the disagreement is printed rather than resolved silently.
   */
  const bandCost = ablation.falsePositives + ablation.falseNegatives;
  if (verdict.startsWith('REMOVE') && bandCost > 0) {
    verdict = `KEEP bands disagree, removal costs ${bandCost} verdicts`;
  }

  const liftText = `${liftLo.toFixed(2)}-${liftHi.toFixed(2)}`;
  const bandText = `${ablation.falsePositives >= 0 ? '+' : ''}${ablation.falsePositives}/${ablation.falseNegatives >= 0 ? '+' : ''}${ablation.falseNegatives}`;

  judged.push({
    id: definition.id,
    separation,
    delta: ablation.deltaAuc,
    lo: ablation.lo,
    hi: ablation.hi,
    families: firedFamilies,
    liftLo,
    liftHi,
    verdict,
    line:
      `${definition.id.padEnd(36)} ${pct(data).padStart(5)} ${pct(abuseRate).padStart(6)} ${pct(legitRate).padStart(6)} ` +
      `${pct(privacyRate).padStart(5)} ${String(firedFamilies).padStart(5)} ${separation.toFixed(2).padStart(7)} ` +
      `${liftText.padStart(16)} ${signed(ablation.deltaAuc).padStart(7)} ` +
      `${`${signed(ablation.lo)},${signed(ablation.hi)}`.padStart(17)} ${bandText.padStart(9)}  ${verdict}`,
  });
}

for (const item of [...judged].sort((a, b) => b.delta - a.delta || b.separation - a.separation)) {
  console.log(item.line);
}

if (duplicates.length > 0) {
  console.log(`\n=== Identical predicates ===`);
  for (const pair of duplicates) {
    console.log(`${pair.a} and ${pair.b} fire on the same domains (${pct(pair.agreement)} agreement)`);
  }
}

console.log(`\n=== Combinations ===`);
console.log(
  `${'combination'.padEnd(36)} ${'abuse'.padStart(6)} ${'legit'.padStart(6)} ${'priv'.padStart(5)} ${'ΔAUC'.padStart(7)} ${'95% CI'.padStart(17)} ${'band'.padStart(9)}  tier`,
);
for (const combination of COMBINATIONS) {
  const record = comboFired.get(combination.id)!;
  const ablation = ablationById.get(combination.id)!;
  const movesBands = ablation.falsePositives !== 0 || ablation.falseNegatives !== 0;
  const fires = record.abuse + record.legit + record.privacy;
  let verdict =
    fires === 0
      ? KEEP_UNMEASURED
      : ablation.hi < 0
        ? 'REMOVE measurably harmful'
        : ablation.lo > 0
          ? 'KEEP measurably useful'
          : !movesBands && record.abuse + record.legit < familyGate
            ? KEEP_UNMEASURED
            : 'KEEP';
  const comboBandCost = ablation.falsePositives + ablation.falseNegatives;
  if (verdict.startsWith('REMOVE') && comboBandCost > 0) {
    verdict = `KEEP bands disagree, removal costs ${comboBandCost} verdicts`;
  }
  const bandText = `${ablation.falsePositives >= 0 ? '+' : ''}${ablation.falsePositives}/${ablation.falseNegatives >= 0 ? '+' : ''}${ablation.falseNegatives}`;
  console.log(
    `${combination.id.padEnd(36)} ${pct(abuseTotal ? record.abuse / abuseTotal : 0).padStart(6)} ` +
      `${pct(legitTotal ? record.legit / legitTotal : 0).padStart(6)} ${pct(privacyTotal ? record.privacy / privacyTotal : 0).padStart(5)} ` +
      `${signed(ablation.deltaAuc).padStart(7)} ${`${signed(ablation.lo)},${signed(ablation.hi)}`.padStart(17)} ${bandText.padStart(9)}  ${verdict}`,
  );
}

console.log(`\n=== Source coverage: a signal cannot be useful if its source never answers ===`);
const coverage = new Map<string, Map<string, number>>();
for (const entry of cached) {
  for (const source of entry.facts.sources) {
    const bySource = coverage.get(source.source) ?? new Map<string, number>();
    bySource.set(source.status, (bySource.get(source.status) ?? 0) + 1);
    coverage.set(source.source, bySource);
  }
}
for (const [source, byStatus] of coverage) {
  const total = [...byStatus.values()].reduce((a, b) => a + b, 0);
  const rendered = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status}=${pct(count / total)}`)
    .join(' ');
  console.log(`${source.padEnd(10)} ${rendered}`);
}

console.log(`\n=== Group ablations: whole dimensions ===`);
const dimensions = [...new Set(SIGNALS.map((definition) => definition.dimension))];
for (const dimension of dimensions) {
  const ids = new Set(SIGNALS.filter((definition) => definition.dimension === dimension).map((d) => d.id));
  const interval = deltaAucCi(scoresOf(scoreAll(ids)));
  console.log(
    `${dimension.padEnd(14)} ΔAUC ${signed(interval.point)} (${signed(interval.lo)}, ${signed(interval.hi)})`,
  );
}

console.log(`\n=== Removing everything the rule marks REMOVE, at once ===`);
const marked = judged.filter((item) => item.verdict.startsWith('REMOVE'));
if (marked.length > 0) {
  const without = scoreAll(new Set(marked.map((item) => item.id)));
  const interval = deltaAucCi(scoresOf(without));
  const bands = bandErrors(without);
  const moved = without.filter((row, index) => row.legitimacy !== baseline[index].legitimacy).length;
  for (const item of marked) console.log(`  ${item.id.padEnd(36)} ${item.verdict}`);
  console.log(
    `AUC ${baselineAuc.toFixed(3)} -> ${(baselineAuc - interval.point).toFixed(3)} ` +
      `(Δ ${signed(interval.point)}, 95% CI ${signed(interval.lo)} to ${signed(interval.hi)})`,
  );
  console.log(
    `Band errors ${baselineBands.falsePositives}/${baselineBands.falseNegatives} -> ` +
      `${bands.falsePositives}/${bands.falseNegatives} (false positives/false negatives), ` +
      `scores moved on ${moved}/${cached.length} domains`,
  );
} else {
  console.log('none');
}

// ---------------------------------------------------------------------------------------------
// Threshold sweep under cross-validation
// ---------------------------------------------------------------------------------------------

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
type Knob = {
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
const KNOBS: Knob[] = [
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
    id: 'site.parked',
    current: DEFAULT_CONFIG.site.parked,
    values: [-18, -15, -12, -9, -6],
    reason: 'the signal where ranking and bands disagree most sharply',
    apply: (cfg, value) => {
      (cfg.site as any).parked = value;
    },
  },
];
/* eslint-enable @typescript-eslint/no-explicit-any */

const FOLDS = 5;

/** Stratified by class, so every fold holds both abuse and legitimate families. */
function assignFolds(): Int32Array {
  const fold = new Int32Array(families.length).fill(-1);
  const shuffle = (list: number[]) => {
    const generator = mulberry32(0xf01d);
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(generator() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  for (const group of [abuseFamilies, legitFamilies]) {
    shuffle(group).forEach((family, position) => {
      fold[family] = position % FOLDS;
    });
  }
  return fold;
}

const foldOf = assignFolds();
const foldFamilies = Array.from({ length: FOLDS }, (_, k) => ({
  testAbuse: Int32Array.from(abuseFamilies.filter((f) => foldOf[f] === k)),
  testLegit: Int32Array.from(legitFamilies.filter((f) => foldOf[f] === k)),
  trainAbuse: Int32Array.from(abuseFamilies.filter((f) => foldOf[f] !== k)),
  trainLegit: Int32Array.from(legitFamilies.filter((f) => foldOf[f] !== k)),
}));

console.log(`\n=== Threshold sweep, ${FOLDS}-fold cross-validated over families ===`);
console.log(
  `Each fold picks its value on the training families and is judged on the held-out ones, so the figures ` +
    `are what the tuning is worth on domains it did not choose on. The objective is the one the service ` +
    `ships and the one the model's own policy states: reduce abuse domains sitting in a legitimate band, ` +
    `without letting a single further legitimate domain into an actionable one. Ranking each candidate by ` +
    `AUC instead was tried first and proposed four changes, every one of which paid for its ranking gain ` +
    `with verdicts.`,
);
console.log(
  `${'knob'.padEnd(38)} ${'current'.padStart(8)} ${'picked'.padStart(8)} ${'agree'.padStart(6)} ` +
    `${'OOF fp'.padStart(7)} ${'OOF fn'.padStart(7)} ${'OOF AUC'.padStart(8)}  adopt`,
);

/** Family-weighted band errors over a set of families, which is what a fold is scored on. */
function weightedBandErrors(
  falsePositive: Uint8Array,
  falseNegative: Uint8Array,
  drawn: Int32Array,
): { falsePositives: number; falseNegatives: number } {
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const family of drawn) {
    for (const member of families[family].members) {
      if (falsePositive[member]) falsePositives += weights[member];
      if (falseNegative[member]) falseNegatives += weights[member];
    }
  }
  return { falsePositives, falseNegatives };
}

const adoptions: { id: string; from: number; to: number; falseNegatives: number }[] = [];

for (const knob of KNOBS) {
  const values = knob.values.includes(knob.current) ? knob.values : [...knob.values, knob.current];
  const scoresFor = new Map<number, Int32Array>();
  const falsePositiveFor = new Map<number, Uint8Array>();
  const falseNegativeFor = new Map<number, Uint8Array>();

  for (const value of values) {
    const cfg = structuredClone(DEFAULT_CONFIG) as ScoringConfig;
    knob.apply(cfg, value);
    const scores = new Int32Array(cached.length);
    const falsePositive = new Uint8Array(cached.length);
    const falseNegative = new Uint8Array(cached.length);
    cached.forEach((entry, position) => {
      const result = score(entry.facts, cfg);
      scores[position] = result.legitimacy;
      if (isLegitimate(entry) && ACTIONABLE.has(result.verdict)) falsePositive[position] = 1;
      if (isAbuse(entry) && LEGITIMATE_BAND.has(result.verdict)) falseNegative[position] = 1;
    });
    scoresFor.set(value, scores);
    falsePositiveFor.set(value, falsePositive);
    falseNegativeFor.set(value, falseNegative);
  }

  const picks: number[] = [];
  const tuned = { falsePositives: 0, falseNegatives: 0, auc: 0 };
  const asIs = { falsePositives: 0, falseNegatives: 0, auc: 0 };

  for (const fold of foldFamilies) {
    const train = Int32Array.from([...fold.trainAbuse, ...fold.trainLegit]);
    const test = Int32Array.from([...fold.testAbuse, ...fold.testLegit]);
    const baselineTrain = weightedBandErrors(
      falsePositiveFor.get(knob.current)!,
      falseNegativeFor.get(knob.current)!,
      train,
    );

    /*
     * Lexicographic rather than a weighted sum, because there is no honest exchange rate between the two
     * errors and inventing one would decide the outcome. The model's stated position is that blocking a
     * real user is the expensive mistake, which makes false positives a constraint rather than a term:
     * candidates that would admit even one more are not considered, and the rest compete on recall.
     */
    let best = knob.current;
    let bestFalseNegatives = baselineTrain.falseNegatives;
    for (const value of values) {
      const errors = weightedBandErrors(falsePositiveFor.get(value)!, falseNegativeFor.get(value)!, train);
      if (errors.falsePositives > baselineTrain.falsePositives + 1e-9) continue;
      if (errors.falseNegatives < bestFalseNegatives - 1e-9) {
        bestFalseNegatives = errors.falseNegatives;
        best = value;
      }
    }
    picks.push(best);

    for (const [value, into] of [
      [best, tuned],
      [knob.current, asIs],
    ] as const) {
      const errors = weightedBandErrors(falsePositiveFor.get(value)!, falseNegativeFor.get(value)!, test);
      into.falsePositives += errors.falsePositives;
      into.falseNegatives += errors.falseNegatives;
      into.auc += weightedAucOver(scoresFor.get(value)!, fold.testAbuse, fold.testLegit);
    }
  }

  const tally = new Map<number, number>();
  for (const pick of picks) tally.set(pick, (tally.get(pick) ?? 0) + 1);
  const [modal, agreement] = [...tally].sort((a, b) => b[1] - a[1])[0];

  const falsePositives = (tuned.falsePositives - asIs.falsePositives) / FOLDS;
  const falseNegatives = (tuned.falseNegatives - asIs.falseNegatives) / FOLDS;
  const aucGain = (tuned.auc - asIs.auc) / FOLDS;

  /**
   * Four conditions. The tuned procedure must admit no more legitimate domains to an actionable band on
   * families it never saw; it must catch measurably more abuse there; the folds must agree, since a value
   * that moves with the split is noise being read as signal; and the winner must differ from what is
   * configured already.
   */
  const adopt =
    falsePositives <= 1e-9 && falseNegatives < -0.5 && agreement >= 4 && modal !== knob.current;
  if (adopt) adoptions.push({ id: knob.id, from: knob.current, to: modal, falseNegatives });

  const why = adopt
    ? 'ADOPT'
    : modal === knob.current
      ? 'leave as is, already best'
      : agreement < 4
        ? 'leave as is, folds disagree'
        : falsePositives > 1e-9
          ? 'leave as is, admits false positives'
          : 'leave as is, recall gain is noise';
  console.log(
    `${knob.id.padEnd(38)} ${String(knob.current).padStart(8)} ${String(modal).padStart(8)} ` +
      `${`${agreement}/${FOLDS}`.padStart(6)} ${falsePositives.toFixed(2).padStart(7)} ` +
      `${falseNegatives.toFixed(2).padStart(7)} ${signed(aucGain).padStart(8)}  ${why}`,
  );
}

if (adoptions.length > 0) {
  console.log('');
  for (const adoption of adoptions) {
    const knob = KNOBS.find((entry) => entry.id === adoption.id)!;
    console.log(`ADOPT ${adoption.id}: ${adoption.from} -> ${adoption.to}, because ${knob.reason}`);
  }
} else {
  console.log(
    `\nNothing to adopt. Every configured value either already wins its sweep or is only beaten by a ` +
      `candidate that buys recall with false positives, so the thresholds stand as they are.`,
  );
}

writeFileSync(
  join(CACHE_DIR, 'report.json'),
  JSON.stringify(
    {
      baselineAuc,
      abuseTotal,
      legitTotal,
      privacyTotal,
      abuseFamilies: abuseFamilies.length,
      legitFamilies: legitFamilies.length,
      familyGate,
      bootstrapDraws,
      baselineBands,
      judged,
      ablations,
      duplicates,
    },
    null,
    2,
  ),
);
