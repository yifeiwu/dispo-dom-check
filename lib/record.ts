import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BlockedHostError,
  HttpError,
  RateLimitedError,
  TimeoutError,
  UnsupportedError,
} from './errors';

/**
 * Records the raw upstream responses an analysis reads, and replays them back into it.
 *
 * Collection is the expensive half of every calibration run, and the facts cache only keeps what the
 * parsers made of a response. That is enough to re-score a weight change but not to re-run a parser: the
 * moment a collector learns to read a field it previously ignored, the whole holdout has to be probed
 * again, against upstreams that have since moved. Keeping the bodies means a parser change is answered
 * offline from the same observations the original run saw.
 *
 * Recording is off unless a caller opts in, so the request path is unchanged: with no active context
 * every wrapper below is a straight passthrough.
 *
 * The unit recorded is one call to `fetchText`, `probe`, `exists` or the port-43 `whois` query, holding
 * the response body exactly as it arrived. That is the boundary where parsing begins, so anything
 * downstream of it is a pure function of what is stored here.
 *
 * WHOIS is the one recorded call that is not HTTP. It is here for exactly the reason the others are:
 * WHOIS text formats vary per registry and the parser will keep learning labels, and a stored run that
 * omitted them would silently lose the age signal for every ccTLD in it the first time it did.
 */

export type RecordedError = {
  kind: 'timeout' | 'rate_limited' | 'unsupported' | 'http' | 'blocked' | 'generic';
  message: string;
  timeoutMs?: number;
  retryAfterMs?: number;
  statusCode?: number;
  url?: string;
};

export type Exchange = {
  call: 'fetchText' | 'probe' | 'whois';
  /** For `whois`, a `whois://server/term` pseudo-URL, since the protocol has no URL of its own. */
  url: string;
  accept?: string;
  redirect?: string;
  /** Absent for every GET, which is what keeps transcripts recorded before this existed readable. */
  method?: string;
  /** The *request* body, distinct from `body` below, which is what came back. */
  requestBody?: string;
  elapsedMs: number;
  /** Response body as received, before any parsing. */
  body?: string;
  status?: number | null;
  finalUrl?: string;
  headers?: Record<string, string>;
  /** Present instead of a response when the call failed, so replay reproduces the same failure. */
  error?: RecordedError;
};

export type Transcript = {
  recordedAt: string;
  exchanges: Exchange[];
};

type Descriptor = Pick<Exchange, 'call' | 'url' | 'accept' | 'redirect' | 'method' | 'requestBody'>;

type Codec<T> = {
  encode: (value: T) => Partial<Exchange>;
  decode: (exchange: Exchange) => T;
};

type Context =
  | { mode: 'record'; exchanges: Exchange[]; shared: boolean }
  | { mode: 'replay'; byKey: Map<string, Exchange[]>; cursor: Map<string, number>; misses: string[] };

type Registry = {
  storage: AsyncLocalStorage<Context>;
  /**
   * Reference data is fetched once per process and shared by every domain, so it is collected separately
   * rather than landing in whichever domain's transcript happened to trigger it.
   */
  sharedExchanges: Exchange[];
};

/**
 * Kept on the global registry rather than in module scope.
 *
 * The calibration scripts are ESM and `lib/` is CommonJS, so the loader hands each side its own instance
 * of this module. A recorder held in module scope would then be a different object from the one the
 * fetch wrappers consult, and would silently record nothing at all.
 */
const REGISTRY_KEY = Symbol.for('domain-legitimacy-scorer.http-recorder');
const globals = globalThis as unknown as Record<symbol, Registry | undefined>;

const registry: Registry = (globals[REGISTRY_KEY] ??= {
  storage: new AsyncLocalStorage<Context>(),
  sharedExchanges: [],
});

const { storage, sharedExchanges } = registry;

/**
 * Both sides default `method` and `requestBody` identically, so a transcript recorded before those
 * fields existed still keys to exactly the string a GET produces today.
 */
function keyOf(descriptor: Descriptor): string {
  return [
    descriptor.call,
    descriptor.method ?? 'GET',
    descriptor.redirect ?? 'follow',
    descriptor.accept ?? '',
    descriptor.url,
    descriptor.requestBody ?? '',
  ].join(' ');
}

/** A request the new code makes that the recording never saw. Reported rather than silently fetched. */
export class TranscriptMissError extends Error {
  constructor(url: string) {
    super(`No recorded response for ${url}; re-collect to capture it`);
    this.name = 'TranscriptMissError';
  }
}

function toRecordedError(error: unknown): RecordedError {
  if (error instanceof TimeoutError) {
    const timeoutMs = Number(error.message.match(/exceeded (\d+)ms/)?.[1]);
    return { kind: 'timeout', message: error.message, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined };
  }
  if (error instanceof RateLimitedError) {
    return { kind: 'rate_limited', message: error.message, retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof UnsupportedError) {
    return { kind: 'unsupported', message: error.message };
  }
  if (error instanceof BlockedHostError) {
    return { kind: 'blocked', message: error.message };
  }
  if (error instanceof HttpError) {
    return { kind: 'http', message: error.message, statusCode: error.statusCode };
  }
  return { kind: 'generic', message: error instanceof Error ? error.message : 'Unknown failure' };
}

/**
 * Rebuilds the thrown error, not merely its text. `runCollector` classifies a timeout, a 429 and a 500
 * differently, so a replayed failure has to arrive as the same type to reach the same status.
 */
function reviveError(recorded: RecordedError, url: string): Error {
  switch (recorded.kind) {
    case 'timeout':
      return new TimeoutError(recorded.timeoutMs ?? 0);
    case 'rate_limited':
      return new RateLimitedError(recorded.message, recorded.retryAfterMs);
    case 'unsupported':
      return new UnsupportedError(recorded.message);
    case 'blocked':
      return new BlockedHostError(recorded.message);
    case 'http':
      return new HttpError(recorded.statusCode ?? 500, recorded.url ?? url);
    default:
      return new Error(recorded.message);
  }
}

/**
 * Wraps one outbound call. Passthrough when nothing is recording, which is every production request.
 */
export async function capture<T>(descriptor: Descriptor, codec: Codec<T>, run: () => Promise<T>): Promise<T> {
  const context = storage.getStore();
  if (!context) return run();

  const key = keyOf(descriptor);

  if (context.mode === 'replay') {
    const recorded = context.byKey.get(key);
    if (!recorded || recorded.length === 0) {
      context.misses.push(key);
      throw new TranscriptMissError(descriptor.url);
    }
    // Repeated identical requests replay in order, then hold on the last response. A GET the new code
    // issues more often than the recording did is answered rather than reported as a gap.
    const index = context.cursor.get(key) ?? 0;
    context.cursor.set(key, index + 1);
    const exchange = recorded[Math.min(index, recorded.length - 1)];
    if (exchange.error) throw reviveError(exchange.error, descriptor.url);
    return codec.decode(exchange);
  }

  const target = context.shared ? sharedExchanges : context.exchanges;
  const startedAt = Date.now();

  try {
    const value = await run();
    target.push({ ...descriptor, elapsedMs: Date.now() - startedAt, ...codec.encode(value) });
    return value;
  } catch (error) {
    target.push({ ...descriptor, elapsedMs: Date.now() - startedAt, error: toRecordedError(error) });
    throw error;
  }
}

/**
 * Whether this analysis is being recorded or replayed rather than served.
 *
 * Exposed for one purpose: a collector that costs money per call has no business running against a
 * holdout of several thousand domains, and the metered Check-Mail source reads this to exclude
 * itself. Gating on the context rather than on an environment variable makes the exclusion a
 * property of how the analysis was invoked, so a calibration run cannot spend the quota by
 * forgetting a flag.
 */
export function hasRecordingContext(): boolean {
  return storage.getStore() !== undefined;
}

/** Runs one analysis, returning its result alongside every response it read. */
export async function withHttpRecording<T>(fn: () => Promise<T>): Promise<{ value: T; transcript: Transcript }> {
  const exchanges: Exchange[] = [];
  const value = await storage.run({ mode: 'record', exchanges, shared: false }, fn);
  return { value, transcript: { recordedAt: new Date().toISOString(), exchanges } };
}

/**
 * Runs one analysis against stored responses with no network at all. Misses are returned rather than
 * fetched: a transcript that no longer covers what the code asks for is a fact the caller needs to see,
 * and quietly filling the gap from the network would make a stale recording look complete.
 */
export async function withHttpReplay<T>(
  transcripts: readonly (Transcript | null | undefined)[],
  fn: () => Promise<T>,
): Promise<{ value: T; misses: string[] }> {
  const byKey = new Map<string, Exchange[]>();
  for (const transcript of transcripts) {
    for (const exchange of transcript?.exchanges ?? []) {
      const key = keyOf(exchange);
      const existing = byKey.get(key);
      if (existing) existing.push(exchange);
      else byKey.set(key, [exchange]);
    }
  }

  const misses: string[] = [];
  const value = await storage.run({ mode: 'replay', byKey, cursor: new Map(), misses }, fn);
  return { value, misses };
}

/**
 * Marks a fetch as process-wide reference data rather than an observation about the domain in hand, so
 * it is recorded once and replayed for every domain.
 */
export function asSharedReference<T>(fn: () => Promise<T>): Promise<T> {
  const context = storage.getStore();
  if (context?.mode !== 'record') return fn();
  return storage.run({ ...context, shared: true }, fn);
}

/** Everything recorded so far that was not specific to a single domain. */
export function sharedTranscript(): Transcript {
  return { recordedAt: new Date().toISOString(), exchanges: [...sharedExchanges] };
}
