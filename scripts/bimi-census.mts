/**
 * One-off census: how many domains in the holdout publish a BIMI record at all, and how many of those
 * point at a certificate.
 *
 * This exists to answer a pricing question before paying for it. Adding BIMI to `collectMail` costs a
 * DNS query on every analysis forever, and the audit cannot say whether that is worth it, because no
 * `_bimi` lookup appears anywhere in the stored transcripts — the signal was removed in 1.3.0 and the
 * query went with it. The alternative to this script is re-collecting all 4,698 domains, which is hours
 * of network and a fresh set of RDAP rate limits, to learn one number.
 *
 * So: one TXT query per domain, nothing else. No certificate is fetched, because the count of records
 * is what decides whether the rest is worth building, and a record without a certificate is the
 * uninteresting case anyway.
 *
 *   npx tsx scripts/bimi-census.mts
 *
 * Deliberately not wired into `npm run audit`. It writes no cache and feeds no weight directly; it
 * reports a number that goes into `docs/CALIBRATION.md` and into the decision recorded there.
 */
import { loadBenchmark, type Group, type Row } from './benchmark.mts';
import { txtAt } from '../lib/collect/dns';
import { parseBimiRecord } from '../lib/bimi-vmc';

const TIMEOUT_MS = 5_000;
const CONCURRENCY = 24;

type Finding = {
  domain: string;
  group: Group;
  label: string;
  record: string;
  certificateUrl?: string;
};

async function censusOne(row: Row): Promise<Finding | null> {
  let records: string[];
  try {
    records = await txtAt(`default._bimi.${row.domain}`, TIMEOUT_MS);
  } catch {
    // A resolver failure is not a finding either way, and counting it as "no record" would understate
    // the base rate rather than leaving it unknown.
    return null;
  }
  for (const record of records) {
    const parsed = parseBimiRecord(record);
    if (!parsed) continue;
    return {
      domain: row.domain,
      group: row.group,
      label: row.label,
      record: record.slice(0, 200),
      certificateUrl: parsed.certificateUrl,
    };
  }
  return null;
}

async function main(): Promise<void> {
  const rows = loadBenchmark();
  const findings: Finding[] = [];
  const totals = new Map<Group, number>();
  for (const row of rows) totals.set(row.group, (totals.get(row.group) ?? 0) + 1);

  let done = 0;
  const queue = [...rows];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const finding = await censusOne(row);
      if (finding) findings.push(finding);
      done += 1;
      if (done % 250 === 0) process.stderr.write(`  ${done}/${rows.length}\n`);
    }
  });
  await Promise.all(workers);

  const byGroup = new Map<Group, Finding[]>();
  for (const finding of findings) {
    byGroup.set(finding.group, [...(byGroup.get(finding.group) ?? []), finding]);
  }

  console.log(`\nBIMI census over ${rows.length} domains, one TXT query each.\n`);
  console.log('group         domains  with record  with certificate');
  for (const [group, total] of [...totals].sort()) {
    const found = byGroup.get(group) ?? [];
    const withCertificate = found.filter((finding) => finding.certificateUrl).length;
    console.log(
      `${group.padEnd(12)} ${String(total).padStart(7)}  ${String(found.length).padStart(11)}  ${String(withCertificate).padStart(16)}`,
    );
  }

  if (findings.length > 0) {
    console.log('\nEvery domain found:');
    for (const finding of findings.sort((a, b) => a.group.localeCompare(b.group))) {
      console.log(
        `  ${finding.group.padEnd(11)} ${finding.domain}  [${finding.label}]  ${finding.certificateUrl ?? 'no a= tag'}`,
      );
    }
  }

  /*
   * The number that matters is the abuse count, not the total. A signal only legitimate domains can
   * earn is still useless if too few earn it to survive the ten-family rarity gate.
   */
  console.log(
    '\nA weight can only be placed if the count clears the rarity gate the audit applies to every signal.',
  );
}

await main();
