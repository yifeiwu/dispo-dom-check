/**
 * Calls the running service for one or more inputs and prints a compact readout.
 *
 * A development aid for eyeballing whether the collectors and the narrative behave sensibly on real
 * domains. Calibration against a labelled set is a separate script.
 */
const inputs = process.argv.slice(2);
const base = process.env.BASE_URL ?? 'http://localhost:3000';

for (const input of inputs) {
  const response = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain: input }),
  });
  const result = await response.json();

  console.log(`\n=== ${input} ===`);

  if (result.error) {
    console.log(`error: ${result.error} — ${result.message}`);
    continue;
  }
  if (result.outOfScope) {
    console.log(`out of scope: ${result.outOfScope.explanation}`);
    continue;
  }

  console.log(
    `legitimacy ${result.legitimacy}  risk ${result.risk}  confidence ${result.confidence}  ${result.verdict}  ${result.elapsedMs}ms`,
  );
  console.log(`age: ${result.ageDays ?? 'unknown'} days  flags: ${result.flags.join(', ') || 'none'}`);
  console.log(`narrative: ${result.narrative}`);
  console.log(`sources: ${result.sources.map((s) => `${s.source}=${s.status}`).join(' ')}`);
  for (const dimension of result.dimensions.filter((d) => d.clamped !== 0)) {
    console.log(`  [${dimension.dimension}] ${dimension.clamped}${dimension.clampApplied ? ' (clamped)' : ''}`);
  }
  for (const signal of result.signals) {
    console.log(`  ${signal.points > 0 ? '+' : ''}${signal.points}\t${signal.id}\t${signal.evidence}`);
  }
  for (const combination of result.combinations) {
    console.log(`  combo ${combination.points}\t${combination.id}\t${combination.evidence}`);
  }
}
