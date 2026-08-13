/**
 * Derives the trust anchors for VMC verification from certificates actually observed.
 *
 * `lib/data/bimi-authorities.ts` pins the public keys a VMC chain may terminate at, and where those
 * values come from matters as much as what they are. Transcribing a fingerprint out of a vendor
 * document and committing it is an act of faith in the document; deriving it from chains served by a
 * few dozen unrelated large companies is an observation. If one key signs certificates for Bank of
 * America, FedEx and Nike, it is a Mark Verifying Authority key, and no single one of them has to be
 * trusted for that to hold.
 *
 * Run after collecting the verification set:
 *
 *   npx tsx scripts/signal-audit.mts --collect --benchmark benchmark-bimi
 *   npx tsx scripts/bimi-anchors.mts
 *
 * Prints the table to paste, plus how many independent domains support each key. It does not write the
 * file: a change to a trust anchor should be a deliberate edit somebody reviewed, not a generated one.
 */
import { X509Certificate } from 'node:crypto';
import { loadBenchmark } from './benchmark.mts';
import { txtAt } from '../lib/collect/dns';
import { fetchText } from '../lib/fetch';
import { parseBimiRecord, publicKeyFingerprint, verifyVmc } from '../lib/bimi-vmc';
import { authorityFor } from '../lib/data/bimi-authorities';

const TIMEOUT_MS = 10_000;

type Anchor = { sha256: string; subject: string; authority: string | null; domains: string[] };

async function chainFor(domain: string): Promise<{ chain: X509Certificate[]; pem: string } | null> {
  let records: string[];
  try {
    records = await txtAt(`default._bimi.${domain}`, TIMEOUT_MS);
  } catch {
    return null;
  }
  const parsed = records.map((record) => parseBimiRecord(record)).find(Boolean);
  if (!parsed?.certificateUrl) return null;

  let pem: string;
  try {
    pem = await fetchText(parsed.certificateUrl, { timeoutMs: TIMEOUT_MS });
  } catch {
    console.log(`  ${domain}: certificate at ${parsed.certificateUrl} was unreachable`);
    return null;
  }

  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  try {
    return { chain: blocks.map((block) => new X509Certificate(block)), pem };
  } catch {
    console.log(`  ${domain}: certificate did not parse`);
    return null;
  }
}

async function main(): Promise<void> {
  const rows = loadBenchmark('benchmark-bimi');
  const anchors = new Map<string, Anchor>();
  let withRecord = 0;

  const outcomes: string[] = [];
  let accepted = 0;

  console.log(`Fetching BIMI chains for ${rows.length} domains.\n`);
  for (const row of rows) {
    const fetched = await chainFor(row.domain);
    if (!fetched || fetched.chain.length === 0) continue;
    const { chain, pem } = fetched;
    withRecord += 1;

    const top = chain[chain.length - 1];
    const fingerprint = publicKeyFingerprint(top);
    const existing = anchors.get(fingerprint);
    if (existing) {
      existing.domains.push(row.domain);
    } else {
      anchors.set(fingerprint, {
        sha256: fingerprint,
        subject: top.subject.replace(/\n/g, ', '),
        authority: authorityFor(top.subject) ?? authorityFor(top.issuer),
        domains: [row.domain],
      });
    }

    /*
     * The half the offline fixtures cannot supply. Those prove every rejection path using certificates
     * generated locally, and a verifier that rejected everything would pass all of them. Only a real
     * chain can show the accepting path works.
     */
    const result = verifyVmc(pem, row.domain);
    if (result.verified) accepted += 1;
    outcomes.push(
      result.verified
        ? `  accept  ${row.domain.padEnd(22)} ${result.issuer}`
        : `  REJECT  ${row.domain.padEnd(22)} ${result.failure}: ${result.detail}`,
    );

    console.log(
      `  ${row.domain}: ${chain.length} certificates, leaf ${chain[0].subject.replace(/\n/g, ', ')}`,
    );
  }

  console.log(`\n${withRecord} of ${rows.length} domains served a certificate chain.\n`);
  console.log(`The verifier accepted ${accepted} of ${withRecord}:\n`);
  for (const line of outcomes) console.log(line);
  console.log(
    '\nA rejection here is worth reading before assuming it is a defect: VMCs are annual and lapse often.\n',
  );
  console.log('Candidate anchors, commonest first:\n');
  for (const anchor of [...anchors.values()].sort((a, b) => b.domains.length - a.domains.length)) {
    console.log(`  ${anchor.subject}`);
    console.log(`    authority: ${anchor.authority ?? 'NOT A KNOWN MVA NAME'}`);
    console.log(`    sha256:    ${anchor.sha256}`);
    console.log(`    supported by ${anchor.domains.length}: ${anchor.domains.join(', ')}`);
    console.log();
  }

  /*
   * A key seen on one domain is that domain's arrangement; a key seen on many unrelated ones is the
   * authority's. The threshold is a judgement rather than a calculation, which is why this prints the
   * count and leaves the decision to whoever edits the table.
   */
  console.log('Pin a key only where several unrelated brands agree on it.');
}

await main();
