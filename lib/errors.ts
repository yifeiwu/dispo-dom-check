/**
 * The failure vocabulary shared by everything that talks to the network.
 *
 * These live apart from `lib/collector.ts` because both the HTTP transport and the recorder throw and
 * classify them, and neither has any business depending on the orchestrator. Held together in one
 * module because they are meaningful only as a set: `runCollector` and `lib/record.ts` each match on
 * the whole list, so a fifth error added to one of those chains and not the other is the failure mode
 * this grouping is meant to make obvious.
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`exceeded ${ms}ms deadline`);
    this.name = 'TimeoutError';
  }
}

export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** A source that does not apply to this domain at all, e.g. a TLD with no RDAP service. */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedError';
  }
}

/**
 * A URL this process declined to request, because its host is an address literal, a reserved name, or
 * its scheme is not one we fetch.
 *
 * Distinct from the failures above because nothing was attempted and nothing went wrong upstream: the
 * refusal is ours. Reporting it as a source that broke would send a reader looking for a fault that is
 * not there, so the message says plainly that the request was refused and why.
 */
export class BlockedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedHostError';
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    url: string,
  ) {
    super(`HTTP ${statusCode} from ${new URL(url).host}`);
    this.name = 'HttpError';
  }
}
