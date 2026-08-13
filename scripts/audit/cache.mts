import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainFacts } from '../../lib/facts';
import type { Group, Row } from '../benchmark.mts';
import { CACHE_DIR, hasRaw, safeName } from '../raw-store.mts';

/**
 * The per-domain facts cache, which is what makes an audit re-runnable without touching the network.
 *
 * Paired with the response transcripts in `raw-store.mts`: this holds what the collectors concluded,
 * that holds what they were answering. A domain is only collected once both are present.
 */

export type Cached = { domain: string; label: string; group: Group; facts: DomainFacts };

export const cachePathFor = (domain: string) => join(CACHE_DIR, `${safeName(domain)}.json`);

export const writeFacts = (row: Row, facts: DomainFacts) =>
  writeFileSync(cachePathFor(row.domain), JSON.stringify({ domain: row.domain, label: row.label, facts }));

/** Marks an input the boundary refused, so it counts as collected rather than being re-probed forever. */
export const writeSkipped = (row: Row, reason: string) =>
  writeFileSync(
    cachePathFor(row.domain),
    JSON.stringify({ domain: row.domain, label: row.label, skipped: reason }),
  );

/**
 * A domain is only considered collected once both halves are on disk. The facts alone were enough while
 * they were all that was stored, but a domain with facts and no transcript is exactly the one that would
 * force a refetch later.
 *
 * A run is therefore resumable, and that is also how a starved source is recovered: delete the cache
 * entries whose stored facts show the source timing out, and re-run `--collect` at a lower concurrency.
 */
export const isCollected = (domain: string) => existsSync(cachePathFor(domain)) && hasRaw(domain);

/**
 * Facts are cached per domain and outlive any one benchmark, so the label is taken from the files being
 * audited rather than from the cache entry. Two datasets can disagree about a domain, and the run must
 * reflect the one it was pointed at.
 */
export function loadCache(rows: Row[]): Cached[] {
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
