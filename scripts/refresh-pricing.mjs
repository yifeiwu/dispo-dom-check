/**
 * Downloads the Porkbun suffix price feed and writes it to `lib/data/suffix-pricing.json`.
 *
 * The feed is fetched here rather than at request time because it was measured taking upwards of twelve
 * seconds, which is longer than the whole analysis budget, and because suffix prices move on the order of
 * months. Committing the snapshot makes the registration economics dimension free and deterministic.
 *
 * Run `npm run refresh:pricing` and commit the diff when a registry changes its pricing.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://api.porkbun.com/api/json/v3/pricing/get';
const OUTPUT = fileURLToPath(new URL('../lib/data/suffix-pricing.json', import.meta.url));

const response = await fetch(SOURCE_URL, {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(60_000),
});

if (!response.ok) {
  throw new Error(`Price feed returned HTTP ${response.status}`);
}

const feed = await response.json();

if (feed.status !== 'SUCCESS' || !feed.pricing) {
  throw new Error('Price feed returned no pricing data');
}

// Only registration and renewal are kept: transfer prices are not scored, and dropping them keeps the
// committed file small enough to review.
const pricing = {};
for (const suffix of Object.keys(feed.pricing).sort()) {
  const entry = feed.pricing[suffix];
  pricing[suffix] = { registration: entry.registration, renewal: entry.renewal };
}

const snapshot = { source: SOURCE_URL, fetchedAt: new Date().toISOString().slice(0, 10), pricing };

await writeFile(OUTPUT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

console.log(`Wrote ${Object.keys(pricing).length} suffixes to ${OUTPUT}`);
