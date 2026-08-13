import { mkdirSync } from 'node:fs';
import { analyze } from '../../lib/analyze';
import { normaliseInput } from '../../lib/domain';
import { sharedTranscript, withHttpRecording, withHttpReplay } from '../../lib/record';
import type { Row } from '../benchmark.mts';
import { pool } from '../cli.mts';
import {
  CACHE_DIR,
  RAW_DIR,
  describeAge,
  hasRaw,
  mergeSharedRaw,
  readRaw,
  readSharedRaw,
  writeRaw,
} from '../raw-store.mts';
import { isCollected, writeFacts, writeSkipped } from './cache.mts';
import { pct } from './stats.mts';

/**
 * The two phases that put facts on disk: probing the network, and re-deriving from what was probed.
 *
 * They are separated from the reports because they are the only part of the audit that is allowed to
 * make a request, and because between them they define what the cache means. Everything downstream is
 * a pure function of what these two leave behind.
 */

export async function collect(rows: Row[], concurrency: number): Promise<void> {
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
        writeSkipped(row, input.kind);
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

/**
 * Rebuilds the facts by running the current collectors against the stored responses. This is the answer
 * to a parser change: no network, and every domain sees exactly what it saw during collection.
 *
 * Two things a replayed run cannot recover, both reported rather than hidden. A request the new code
 * makes that the recording never saw has no answer and is counted as a miss. And anything measured
 * against the clock, registration age above all, is computed from today rather than from the day the
 * response was captured, so an old transcript ages its domains along with it.
 */
export async function reparse(rows: Row[], concurrency: number): Promise<void> {
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
