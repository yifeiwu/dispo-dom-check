import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { Transcript } from '../lib/record';

/**
 * On-disk home for the raw responses a collection run saw, shared by `calibrate` and `audit`.
 *
 * Probing the holdout is the only expensive part of either script, so what it observed is kept in the
 * form it arrived in. A parser change is then re-measured by replaying these bodies rather than by
 * probing several thousand domains again, against upstreams that answer differently every week.
 *
 * Bodies are mostly HTML and JSON and compress by roughly an order of magnitude, which is the difference
 * between a cache worth keeping and one worth deleting.
 */

export const CACHE_DIR = '.audit-cache';
export const RAW_DIR = join(CACHE_DIR, 'raw');

/** Reference data every domain shares, recorded once per collection run. */
const SHARED_FILE = join(RAW_DIR, '_shared.json.gz');

export const safeName = (domain: string) => domain.replace(/[^a-z0-9.-]/gi, '_');

export const rawPathFor = (domain: string) => join(RAW_DIR, `${safeName(domain)}.json.gz`);

export const hasRaw = (domain: string) => existsSync(rawPathFor(domain));

function read(path: string): Transcript | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Transcript;
  } catch {
    return null;
  }
}

function write(path: string, transcript: Transcript): void {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(transcript), 'utf8')));
}

export const readRaw = (domain: string) => read(rawPathFor(domain));
export const writeRaw = (domain: string, transcript: Transcript) => write(rawPathFor(domain), transcript);

export const readSharedRaw = () => read(SHARED_FILE);

/** Merged with what is already stored, so a partial run does not drop reference data an earlier one saw. */
export function mergeSharedRaw(transcript: Transcript): void {
  const existing = readSharedRaw();
  const seen = new Set<string>();
  const exchanges = [...(existing?.exchanges ?? []), ...transcript.exchanges].filter((exchange) => {
    const key = `${exchange.call} ${exchange.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  write(SHARED_FILE, { recordedAt: transcript.recordedAt, exchanges });
}

/** How stale the stored responses are, which is the one thing a replayed run cannot tell from the data. */
export function describeAge(transcript: Transcript | null): string {
  if (!transcript) return 'no recording';
  const days = Math.floor((Date.now() - Date.parse(transcript.recordedAt)) / 86_400_000);
  return days <= 0 ? 'recorded today' : `recorded ${days} day${days === 1 ? '' : 's'} ago`;
}
