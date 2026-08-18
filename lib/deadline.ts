import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The whole-analysis deadline, carried out of band so that the exits to the network can observe it.
 *
 * `BUDGET.globalMs` used to bound an analysis by arithmetic alone. `remaining()` shrinks the deadline
 * handed to each *subsequent* collector, which keeps the total honest, but it has no effect on a request
 * already in flight: that one keeps its own per-source timeout, so a source started just before the
 * budget ran out holds a socket open behind a response that has already been sent. On a platform billing
 * for wall-clock time and against upstreams being used for free, that is worth stopping.
 *
 * It is ambient rather than a parameter, in the same way and for the same reason the recorder's context
 * is. The alternative is threading a signal through `collectMail`, `txtAt`, `query` and a dozen
 * intermediate helpers, none of which have any use for it, to reach the two functions that do.
 *
 * A plain module-scope store is enough here, where `lib/record.ts` needs a global registry: both the
 * writer and the readers live in `lib/`, so they cannot be handed different instances of this module the
 * way an ESM script and a CommonJS library can.
 */
const storage = new AsyncLocalStorage<AbortSignal>();

/** Runs an analysis with `signal` bounding every request it makes. */
export function withDeadline<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return storage.run(signal, run);
}

/**
 * Runs work that is deliberately allowed to outlive the analysis that started it.
 *
 * The registry bootstrap is the case this exists for. It is fetched under whichever analysis reached it
 * first and keeps running after that analysis has stopped waiting, so the request after it finds the
 * data cached — see `lib/reference-cache.ts`. Left inside the deadline it would be cancelled at exactly
 * the moment it became useful to anyone.
 */
export function outsideDeadline<T>(run: () => T): T {
  return storage.exit(run);
}

/** The deadline bounding the analysis in progress, where this is running under one. */
export function currentDeadline(): AbortSignal | undefined {
  return storage.getStore();
}
