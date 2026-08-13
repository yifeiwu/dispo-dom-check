import { isAbuse, isLegitimate, type Row } from '../benchmark.mts';

/**
 * Grouping the holdout into independent operators, which is what every figure in the audit is weighted
 * and resampled by.
 *
 * This is the single most consequential piece of arithmetic in the run and the easiest to overlook. The
 * abuse half is largely machine-generated names, so counted by domain a signal that fires on one
 * operator's four hundred registrations looks four hundred times better supported than it is.
 */

/**
 * One operator's generated names collapse to a single key: `mail01.example` through `mail99.example`
 * are one family.
 */
export function familyKey(domain: string): string {
  const parts = domain.split('.');
  const label = parts[0];
  const suffix = parts.slice(1).join('.');
  const stripped = label.replace(/\d+/g, '#');
  return `${stripped}|${suffix}`;
}

export type Family = { members: number[]; abuse: boolean; legit: boolean };

/**
 * Weighting each family to a total of one keeps every domain in the run while giving a family of 400 no
 * more say than a family of 1. Resampling *families* rather than domains then gives an interval that
 * reflects how few independent operators some signals have actually been seen by.
 */
export function buildFamilies(
  entries: readonly (Row & Record<string, unknown>)[],
): { families: Family[]; familyOf: Int32Array; weights: Float64Array } {
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
