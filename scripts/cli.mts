/**
 * Argument parsing and the work pool, shared by `calibrate` and `audit`.
 *
 * Both scripts walk the same holdout a few thousand domains at a time, so both want the same two things:
 * a couple of flags off the command line, and a way to run one function over every row without letting a
 * slow domain pace the rest.
 */

export function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export const flag = (name: string) => process.argv.includes(`--${name}`);

/**
 * A rolling pool rather than fixed batches, because the two differ by a lot on this workload.
 *
 * Batching waits for the slowest domain in each group before starting the next, and `BUDGET.globalMs`
 * lets a single domain run for 15 seconds. The abuse half is largely dead or parked and times out often,
 * so under batching one straggler paced every group and the pool sat mostly idle. Workers pull from a
 * shared cursor instead, so a slow domain occupies one worker rather than blocking the rest.
 *
 * Failures are collected rather than thrown. A domain that fails is one the run did not measure, which is
 * worth counting; abandoning several thousand others over it is not.
 */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
  verb: string,
): Promise<{ results: R[]; failures: unknown[] }> {
  const results: R[] = [];
  const failures: unknown[] = [];
  let next = 0;
  let done = 0;
  const startedAt = Date.now();
  let lastReport = 0;

  const report = (force: boolean) => {
    // Throttled, because a per-domain write to a redirected stderr is itself measurable at this size.
    const now = Date.now();
    if (!force && now - lastReport < 1_000) return;
    lastReport = now;
    const elapsed = (now - startedAt) / 1000;
    const rate = done / Math.max(elapsed, 0.001);
    const remaining = rate > 0 ? Math.round((items.length - done) / rate) : 0;
    process.stderr.write(
      `  ${verb} ${done}/${items.length} (${rate.toFixed(1)}/s, ~${Math.floor(remaining / 60)}m${remaining % 60}s left)   \r`,
    );
  };

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results.push(await run(items[index]));
      } catch (error) {
        failures.push(error);
      }
      done += 1;
      report(false);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  report(true);
  process.stderr.write('\n');

  return { results, failures };
}
