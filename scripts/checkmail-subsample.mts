/**
 * Stratified Check-Mail subsample.
 *
 * `signup.checkmail` is the only weight never validated against the holdout: the source is metered at
 * 1,000 lookups a month, so `lib/analyze.ts` skips it on every recorded or replayed run. This script
 * is the way to measure it without spending the month on the whole holdout.
 *
 * It draws a reproducible sample of about 180 domains, over-sampling the 123 `DISPOSABLE` rows and
 * the free-routing legitimate false positives, then asks Check-Mail about those names only. Results
 * land in `.audit-cache/checkmail-subsample.json` and never touch the facts cache the audit reads.
 *
 *   npx tsx scripts/checkmail-subsample.mts            # prints the sample; queries if a key is set
 *   npx tsx scripts/checkmail-subsample.mts --size 180
 *
 * Calibration collection must not call this. The monthly allowance is shared with production.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectCheckMail } from '../lib/collect/checkmail';
import { score } from '../lib/scoring/score';
import { BUDGET } from '../lib/budget';
import { arg, pool } from './cli.mts';
import { CACHE_DIR } from './raw-store.mts';
import { loadCache, type Cached } from './audit/cache.mts';
import { loadBenchmark, type Row } from './benchmark.mts';
import { mulberry32, pct } from './audit/stats.mts';

const OUTPUT = join(CACHE_DIR, 'checkmail-subsample.json');
const SAMPLE_SIZE = Number(arg('size', '180'));
const CONCURRENCY = Number(arg('concurrency', '4'));

type Sampled = {
  domain: string;
  label: string;
  group: Row['group'];
  stratum: string;
  signupClass?: string;
};

function loadRows(): Row[] | null {
  try {
    return loadBenchmark();
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Pick without replacement, deterministically, so two runs of the same cache produce the same bill.
 */
function take<T>(items: T[], count: number, random: () => number): T[] {
  const poolItems = [...items];
  const picked: T[] = [];
  while (picked.length < count && poolItems.length > 0) {
    const index = Math.floor(random() * poolItems.length);
    picked.push(poolItems.splice(index, 1)[0]!);
  }
  return picked;
}

function stratify(rows: Row[], cached: Cached[], size: number): Sampled[] {
  const factsFor = new Map(cached.map((entry) => [entry.domain, entry.facts]));
  const asSample = (row: Row, stratum: string): Sampled => ({
    domain: row.domain,
    label: row.label,
    group: row.group,
    stratum,
    signupClass: factsFor.get(row.domain)?.signup?.class,
  });

  const disposable = rows.filter((row) => row.label === 'DISPOSABLE').map((row) => asSample(row, 'disposable'));
  const freeRoutingLegit = cached
    .filter((entry) => entry.group === 'legitimate' && entry.facts.signup?.class === 'free_routing')
    .map((entry) => asSample(entry, 'free_routing_legitimate'));

  const used = new Set([...disposable, ...freeRoutingLegit].map((row) => row.domain));
  const remaining = (group: Row['group'], stratum: string) =>
    rows.filter((row) => row.group === group && !used.has(row.domain)).map((row) => asSample(row, stratum));

  const random = mulberry32(0x51b5a1e);
  const picked: Sampled[] = [...disposable, ...freeRoutingLegit];
  const leftover = size - picked.length;
  // Split what remains across the three graded-or-reported groups, with abuse taking the largest share
  // because that is where a disposable verdict would change a band.
  const abuseShare = Math.max(0, Math.floor(leftover * 0.5));
  const legitShare = Math.max(0, Math.floor(leftover * 0.3));
  const privacyShare = Math.max(0, leftover - abuseShare - legitShare);

  for (const row of take(remaining('abuse', 'abuse_sample'), abuseShare, random)) {
    used.add(row.domain);
    picked.push(row);
  }
  for (const row of take(remaining('legitimate', 'legitimate_sample'), legitShare, random)) {
    used.add(row.domain);
    picked.push(row);
  }
  for (const row of take(remaining('privacy', 'privacy_sample'), privacyShare, random)) {
    picked.push(row);
  }

  return picked;
}

function reportPlan(sample: Sampled[]): void {
  const byStratum = new Map<string, number>();
  for (const row of sample) byStratum.set(row.stratum, (byStratum.get(row.stratum) ?? 0) + 1);
  console.log(`Sample of ${sample.length} domains:`);
  for (const [stratum, count] of [...byStratum.entries()].sort()) {
    console.log(`  ${stratum}: ${count}`);
  }
}

async function main(): Promise<void> {
  const rows = loadRows();
  if (!rows) {
    console.log('Nothing to sample. Place the grouped holdout files in benchmark/ and re-run.');
    process.exit(0);
  }

  const cached = existsSync(CACHE_DIR) ? loadCache(rows) : [];
  const sample = stratify(rows, cached, SAMPLE_SIZE);
  reportPlan(sample);

  const key = process.env.CHECKMAIL_API_KEY?.trim();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, 'checkmail-subsample.plan.json'), JSON.stringify(sample, null, 2));

  if (!key) {
    console.log(
      'No CHECKMAIL_API_KEY is set, so nothing was queried. The sample is at ' +
        '.audit-cache/checkmail-subsample.plan.json. Re-run with a key to spend that many lookups.',
    );
    return;
  }

  console.log(`Querying Check-Mail for ${sample.length} domains at concurrency ${CONCURRENCY}.`);
  const { results, failures } = await pool(
    sample,
    CONCURRENCY,
    async (row) => {
      const collected = await collectCheckMail(row.domain, BUDGET.checkmailMs);
      return { row, facts: collected.facts };
    },
    'checkmail',
  );

  const factsFor = new Map(cached.map((entry) => [entry.domain, entry.facts]));
  const scored = results.map(({ row, facts }) => {
    const prior = factsFor.get(row.domain);
    const withReputation = prior ? { ...prior, checkmail: facts } : undefined;
    const before = prior ? score(prior) : undefined;
    const after = withReputation ? score(withReputation) : undefined;
    return {
      domain: row.domain,
      label: row.label,
      group: row.group,
      stratum: row.stratum,
      vendorDisposable: facts.disposable,
      vendorRisk: facts.risk,
      vendorProvider: facts.provider,
      flagBefore: before?.flags.includes('disposable') ?? false,
      flagAfter: after?.flags.includes('disposable') ?? false,
      verdictBefore: before?.verdict,
      verdictAfter: after?.verdict,
    };
  });

  const disposableRows = scored.filter((row) => row.label === 'DISPOSABLE');
  const caught = disposableRows.filter((row) => row.vendorDisposable).length;
  const flagGained = scored.filter((row) => !row.flagBefore && row.flagAfter).length;

  const payload = {
    collectedAt: new Date().toISOString(),
    sampleSize: sample.length,
    failures: failures.length,
    disposableRows: disposableRows.length,
    vendorCaughtDisposable: caught,
    vendorCatchRate: disposableRows.length ? caught / disposableRows.length : null,
    disposableFlagGained: flagGained,
    rows: scored,
  };
  writeFileSync(OUTPUT, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${OUTPUT}`);
  console.log(
    `DISPOSABLE rows in sample: ${disposableRows.length}; vendor called disposable: ${caught}` +
      (disposableRows.length ? ` (${pct(caught / disposableRows.length)})` : ''),
  );
  console.log(`Model disposable flag newly raised by the vendor: ${flagGained}`);
  if (failures.length > 0) console.log(`Failures: ${failures.length}`);
}

await main();
