import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Loads the labelled holdout, shared by `calibrate` and `audit`.
 *
 * The holdout is three grouped files — `benchmark/abuse.csv`, `benchmark/legitimate.csv` and
 * `benchmark/privacy.csv` — and the grouping is the part that matters to a measurement. The file a
 * domain sits in decides how it is graded; the `classification` column inside it is the finer label,
 * which only ever splits a group for reporting. `abuse.csv` holding both `ABUSE` and `DISPOSABLE` is
 * therefore one graded class reported as two rows, not a labelling error.
 */

export const BENCHMARK_DIR = 'benchmark';

/**
 * How a group counts when the model is being graded.
 *
 * `privacy` is deliberately neither class. A privacy or forwarding service is a legitimate product that
 * is also ideal for minting accounts, so the model flags the capability and leaves the policy to the
 * consumer. Grading those domains as abuse would score the model against a ruling it refuses to make,
 * and grading them as legitimate would reward it for missing the capability it exists to detect. Their
 * distribution is still reported, because where they land relative to the two graded classes is worth
 * knowing; it just never counts as a hit or a miss.
 */
export type Group = 'abuse' | 'legitimate' | 'privacy';

const GROUPS: Group[] = ['abuse', 'legitimate', 'privacy'];

export type Row = { domain: string; label: string; group: Group };

export const isAbuse = (row: Row) => row.group === 'abuse';
export const isLegitimate = (row: Row) => row.group === 'legitimate';
export const isGraded = (row: Row) => row.group !== 'privacy';

/** Graded groups first, so a report reads abuse, legitimate, then the ungraded remainder. */
export function orderedLabels(rows: readonly Row[]): { label: string; group: Group }[] {
  const seen = new Map<string, Group>();
  for (const row of rows) if (!seen.has(row.label)) seen.set(row.label, row.group);
  return [...seen]
    .sort(([aLabel, aGroup], [bLabel, bGroup]) =>
      GROUPS.indexOf(aGroup) - GROUPS.indexOf(bGroup) || aLabel.localeCompare(bLabel),
    )
    .map(([label, group]) => ({ label, group }));
}

function parse(path: string, group: Group): Row[] {
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const columns = lines[0].split(',').map((column) => column.trim().toLowerCase());
  const domainAt = columns.indexOf('domain');
  const labelAt = columns.indexOf('classification');

  if (domainAt === -1) throw new Error(`${path}: expected a 'domain' column, found: ${columns.join(', ')}`);

  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const domain = cells[domainAt]?.trim();
    if (!domain) continue;
    const label = cells[labelAt]?.trim().toUpperCase() || group.toUpperCase();
    rows.push({ domain, label, group });
  }
  return rows;
}

/**
 * A domain listed in two groups is dropped rather than assigned to whichever file was read first, since
 * nothing here can tell which grouping is the right one.
 */
export function loadBenchmark(dir: string = BENCHMARK_DIR): Row[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `No benchmark directory at ${dir}. The holdout is not committed: place the grouped files ` +
        `(${GROUPS.map((group) => `${group}.csv`).join(', ')}) there, or pass --benchmark <dir>.`,
    );
  }

  const files = readdirSync(dir).filter((file) => file.endsWith('.csv')).sort();
  if (files.length === 0) throw new Error(`No group files in ${dir}`);

  const byDomain = new Map<string, Row>();
  const conflicting = new Set<string>();
  const ungrouped: string[] = [];

  for (const file of files) {
    const group = basename(file, '.csv').toLowerCase() as Group;
    if (!GROUPS.includes(group)) {
      ungrouped.push(file);
      continue;
    }
    for (const row of parse(join(dir, file), group)) {
      const seen = byDomain.get(row.domain);
      if (seen === undefined) byDomain.set(row.domain, row);
      else if (seen.group !== row.group) conflicting.add(row.domain);
    }
  }

  if (ungrouped.length > 0) {
    console.warn(`Ignored ${ungrouped.join(', ')}: a file name must name a group (${GROUPS.join(', ')}).`);
  }
  if (conflicting.size > 0) {
    console.warn(`${conflicting.size} domains appear in more than one group and were dropped.`);
  }

  return [...byDomain.values()].filter((row) => !conflicting.has(row.domain));
}

/**
 * Narrows a run to named groups, which is what makes it possible to top up the cache for one group
 * without probing the others. A group named here that the data does not contain is an error rather
 * than an empty run, since the likeliest cause is a typo that would otherwise look like a finished job.
 */
export function filterGroups(rows: Row[], names: string): Row[] {
  const wanted = names
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  const unknown = wanted.filter((name) => !GROUPS.includes(name as Group));
  if (unknown.length > 0) throw new Error(`Unknown group ${unknown.join(', ')}; expected ${GROUPS.join(', ')}`);

  const selected = rows.filter((row) => wanted.includes(row.group));
  if (selected.length === 0) throw new Error(`No rows in group ${wanted.join(', ')}`);
  return selected;
}

export function describeGroups(rows: Row[]): string {
  return GROUPS.filter((group) => rows.some((row) => row.group === group))
    .map((group) => {
      const inGroup = rows.filter((row) => row.group === group);
      const labels = [...new Set(inGroup.map((row) => row.label))].sort();
      const breakdown =
        labels.length > 1
          ? ` (${labels.map((label) => `${label} ${inGroup.filter((row) => row.label === label).length}`).join(', ')})`
          : '';
      return `${group}=${inGroup.length}${breakdown}`;
    })
    .join('  ');
}
