import { BUDGET, USER_AGENT } from './budget';
import { BlockedHostError, HttpError, RateLimitedError, TimeoutError } from './errors';
import { isIpLiteral, isReservedName } from './domain-syntax';
import { currentDeadline } from './deadline';
import { capture } from './record';

/**
 * Every outbound request goes through here so that timeouts, body caps, redirect handling, the
 * User-Agent and 429 handling are uniform. Bodies are read through a capped reader rather than
 * `.text()` because a hostile or misconfigured host can otherwise stream until the function dies, and
 * redirects are followed here rather than by the runtime so that the hop limit and the boundary's host
 * rules apply to the whole chain instead of only its first request.
 *
 * Being the only HTTP exit to the network, this is also where responses are recorded for replay. `capture`
 * is a passthrough unless a caller has opened a recording context, so the request path is unaffected. The
 * port-43 WHOIS query is the one call that does not pass through here, and records itself the same way.
 */

type FetchOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Follow redirects. The site probe wants this; API calls generally do not. */
  redirect?: RequestRedirect;
  maxBytes?: number;
  /** Defaults to GET. Only the Check-Mail collector sends anything else. */
  method?: string;
  /** Request body, sent verbatim. The caller supplies its own `content-type`. */
  body?: string;
};

/** Retry once on a 429 that advertises a short `Retry-After`, otherwise degrade immediately. */
const MAX_RETRY_AFTER_MS = 1_500;

function jitter(ms: number): number {
  return ms + Math.random() * 250;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(decoder.decode(value.slice(0, Math.max(0, maxBytes - (total - value.byteLength)))));
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return chunks.join('');
}

/** One request, with no redirect handling of its own. */
async function once(
  url: string,
  options: FetchOptions,
  redirect: RequestRedirect,
  signal: AbortSignal,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? BUDGET.perSourceMs;
  try {
    return await fetch(url, {
      signal,
      redirect,
      method: options.method,
      body: options.body,
      headers: { 'user-agent': USER_AGENT, ...options.headers },
    });
  } catch (error) {
    // An abort raises a `DOMException`, which would otherwise be classified as a generic failure and
    // reported to the user as the source being broken rather than slow. The distinction matters: one is
    // worth retrying and the other is not.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new TimeoutError(timeoutMs);
    }
    throw error;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The request's own deadline, and the analysis-wide one where there is one.
 *
 * Both have to be able to end a request, and they answer different questions. The per-source timeout is
 * what reports a slow source as slow; the analysis deadline is what stops a source still working after
 * the analysis has stopped waiting for it. Composed rather than chosen between, because the shorter of
 * the two is not knowable in advance: a source started early is bounded by its own deadline, and one
 * started late by what is left of the analysis.
 *
 * Absent outside an analysis, which is the case for the refresh scripts and most of the test suite, and
 * the per-source deadline stands alone there.
 */
function boundedByAnalysis(own: AbortSignal): AbortSignal {
  const analysis = currentDeadline();
  return analysis ? AbortSignal.any([own, analysis]) : own;
}

/**
 * Why this URL will not be requested, or `null` if it may be.
 *
 * `normaliseInput` rejects address literals and reserved names before anything is probed, but that
 * decision covers only the host the caller submitted. Every other URL in the system is a host chosen by
 * the domain under analysis — a redirect target, or the certificate a BIMI record names — so without
 * the same test the gate holds for exactly one request: a name answering `302 http://169.254.169.254/`
 * would be fetched, read, and reported back with its status, size and title attached to the result.
 *
 * Returns a reason rather than a boolean because one of the two callers has to explain itself. A
 * refused hop has a response already in hand to report; a refused initial URL has nothing, and "the
 * source was unavailable" would describe an upstream fault rather than our own decision.
 *
 * Known limit: a public name that resolves to a private address still passes. Catching that needs the
 * probe to resolve the name and pin the address it connects to, rather than test the string, which is a
 * larger change than this guard and is not attempted here.
 */
function refusalReason(target: URL): string | null {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return `Refused to request a ${target.protocol} URL: only http and https are fetched`;
  }
  const host = target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIpLiteral(host)) return `Refused to request ${host}: an address literal is not a public host`;
  if (isReservedName(host)) return `Refused to request ${host}: a reserved name is not a public host`;
  return null;
}

/**
 * One request and its redirect chain, followed under our own rules rather than the runtime's.
 *
 * Handing `redirect: 'follow'` to the platform caps the chain at twenty hops and revalidates nothing in
 * between, so `BUDGET.maxRedirects` described a limit that was never applied. Following the chain here
 * applies it, and gives every hop the same test the submitted host received.
 *
 * The whole chain shares one `AbortSignal`, so the deadline still bounds the request rather than each
 * hop within it. Given a signal per hop, a five-hop redirect would cost six times its collector's budget.
 *
 * A refused or over-long chain returns the last response reached, which is the redirect itself. That is
 * the honest reading: the domain answered and pointed somewhere this probe will not go, so the site is
 * reachable but not substantive, and nothing about the target is read or reported.
 *
 * The initial URL faces the same test, and is the reason this guard is not only about redirects. Most
 * callers pass a URL this process composed, but not all of them: the BIMI collector fetches the
 * certificate a domain's own TXT record names, so a domain that publishes an enforcing DMARC policy —
 * which is also its own to publish — can name any address it likes and have it requested from here.
 * A refusal throws, because unlike a hop there is no response to hand back.
 */
async function request(
  url: string,
  options: FetchOptions,
): Promise<{ response: Response; finalUrl: string }> {
  const mode = options.redirect ?? 'follow';
  const signal = boundedByAnalysis(AbortSignal.timeout(options.timeoutMs ?? BUDGET.perSourceMs));

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new BlockedHostError(`Refused to request ${url}: not a valid URL`);
  }
  const refusal = refusalReason(target);
  if (refusal) throw new BlockedHostError(refusal);

  if (mode !== 'follow') {
    return { response: await once(url, options, mode, signal), finalUrl: url };
  }

  let current = url;
  let response = await once(current, options, 'manual', signal);

  for (let hop = 0; hop < BUDGET.maxRedirects; hop += 1) {
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) break;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      break;
    }
    if (refusalReason(next)) break;

    // The body of a redirect is never read, and leaving it open holds the connection for the rest of
    // the chain.
    await response.body?.cancel().catch(() => undefined);

    current = next.toString();
    response = await once(current, options, 'manual', signal);
  }

  // Tracked here rather than read back from `response.url`, which the runtime only fills in for a chain
  // it followed itself. Following it here would otherwise report every redirect as having stayed put.
  return { response, finalUrl: current };
}

/**
 * The request properties that can change the response, and so have to identify it on replay.
 *
 * `method` and `requestBody` are here because the Check-Mail collector sends every domain to one
 * URL and distinguishes them only by the form body. Left out, every domain in a recording would
 * share a key and replay would answer all of them with whichever was captured first.
 */
function descriptorFor(call: 'fetchText' | 'probe', url: string, options: FetchOptions) {
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    call,
    url,
    accept: headers.accept,
    redirect: options.redirect,
    method: options.method,
    requestBody: options.body,
  } as const;
}

/**
 * Fetches text, throwing typed errors that `runCollector` knows how to classify.
 * A 429 or 403 becomes `RateLimitedError`; any other non-2xx becomes `HttpError`.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  return capture(
    descriptorFor('fetchText', url, options),
    { encode: (body) => ({ body }), decode: (exchange) => exchange.body ?? '' },
    async () => {
      let { response } = await request(url, options);

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_MS) {
          await new Promise((resolve) => setTimeout(resolve, jitter(retryAfter)));
          ({ response } = await request(url, options));
        }
        if (response.status === 429) {
          throw new RateLimitedError(`Rate limited by ${new URL(url).host}`, retryAfter);
        }
      }

      if (!response.ok) {
        throw new HttpError(response.status, url);
      }

      return readCapped(response, options.maxBytes ?? BUDGET.maxBodyBytes);
    },
  );
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const body = await fetchText(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  });
  return JSON.parse(body) as T;
}

/**
 * Result of a probe where a non-2xx response is information rather than failure: the site collector
 * needs to distinguish a 404 from a connection refusal, and a soft 404 from a real page.
 */
export type ProbeResult = {
  status: number;
  finalUrl: string;
  body: string;
  headers: Headers;
};

export async function probe(url: string, options: FetchOptions = {}): Promise<ProbeResult> {
  return capture(
    descriptorFor('probe', url, options),
    {
      encode: (result) => ({
        status: result.status,
        finalUrl: result.finalUrl,
        body: result.body,
        headers: Object.fromEntries(result.headers),
      }),
      decode: (exchange) => ({
        status: exchange.status ?? 0,
        finalUrl: exchange.finalUrl ?? url,
        body: exchange.body ?? '',
        headers: new Headers(exchange.headers ?? {}),
      }),
    },
    async () => {
      const { response, finalUrl } = await request(url, options);
      return {
        status: response.status,
        finalUrl,
        body: await readCapped(response, options.maxBytes ?? BUDGET.maxBodyBytes),
        headers: response.headers,
      };
    },
  );
}