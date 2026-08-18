import { NextResponse } from 'next/server';
import { analyze } from '@/lib/analyze';
import { normaliseInput, type NormalisedInput } from '@/lib/domain';
import { toAnalyzeResponse, toOutOfScopeResponse } from '@/lib/api-response';
import { NDJSON_MEDIA_TYPE, type AnalyzeStreamEvent } from '@/lib/api-types';
import { encodeLine } from '@/lib/ndjson';

/**
 * The analysis endpoint.
 *
 * Node runtime because the collectors need `fetch` against arbitrary hosts and a generous timeout.
 * `maxDuration` is well above the internal global deadline so the function is never killed mid-request:
 * the budget inside the orchestrator is what actually bounds the work, and it degrades gracefully where
 * the platform would simply cut the response.
 *
 * It is set to several times `BUDGET.globalMs` rather than to the platform ceiling, which is minutes.
 * A larger number would buy nothing, because nothing here is allowed to run that long: its only job is
 * to be the backstop that never fires, and a backstop set in minutes just means a runaway request holds
 * a browser open for minutes.
 *
 * Two body forms, selected by `accept`. The default is a single JSON object, which is the published
 * contract and what every existing caller reads. Asking for `application/x-ndjson` gets the same
 * analysis reported as it happens: one line per source as it settles, then the identical payload as a
 * terminal `result` line. Progress is opt-in rather than the default because a caller that wanted one
 * object should not have to learn a framing to keep working.
 *
 * The rejection paths above the branch stay plain JSON with their status codes in every case. A 400 is
 * knowable before any work starts, so there is nothing to stream and no reason to lose the status code
 * by moving the failure in-band.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Every response from this endpoint, not only the successful ones.
 *
 * A fresh lookup per request is the requirement, and a stale verdict on a domain that was clean last
 * week is worse than a slow one. The rejections need it just as much: a 400 or a 429 held by an
 * intermediary would answer a later request about a different domain, or keep refusing a client whose
 * window has long since rolled over.
 */
const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * Light in-memory rate limit. Serverless instances are not shared, so this is a courtesy brake against
 * a single client hammering the free upstream APIs rather than a security control. A real limit needs the
 * shared store that the cache interface is already waiting for.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };
const hits = new Map<string, number[]>();

/** Whether this client is over the limit, and when the oldest request in its window falls out of it. */
function rateLimited(key: string): { limited: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((at) => now - at < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(key, recent);

  // Bound the map so a long-lived instance cannot grow without limit.
  if (hits.size > 500) {
    for (const [existing, timestamps] of hits) {
      if (timestamps.every((at) => now - at >= RATE_LIMIT.windowMs)) hits.delete(existing);
    }
  }

  // When the oldest request still counted against this client expires, there is room for another. A
  // caller told only that it was refused has to guess, and guessing badly is how a polite client turns
  // into the thing this brake exists to stop.
  const oldest = recent[0] ?? now;
  const retryAfterSeconds = Math.max(1, Math.ceil((RATE_LIMIT.windowMs - (now - oldest)) / 1000));

  return { limited: recent.length > RATE_LIMIT.maxRequests, retryAfterSeconds };
}

/**
 * Who to count this request against.
 *
 * Both headers are set by the proxy in front of the function rather than by the caller, and neither is
 * trustworthy beyond that: `x-forwarded-for` is a list a client can prepend to, so only the hop the
 * proxy appended means anything, and this reads the first entry because that is the convention on the
 * platform this deploys to.
 *
 * The fallback matters more than which header wins. Keyed to a single `unknown` bucket, every caller
 * arriving without either header shares one allowance, so twenty requests from anywhere lock out
 * everyone else in the same position — a brake against one heavy client turned into an outage for all
 * the light ones. Requests that cannot be attributed are better left uncounted: this limit is a
 * courtesy to the free upstreams rather than a security control, and it says so.
 */
function clientKey(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip')?.trim() || null;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return handle(url.searchParams.get('domain') ?? '', request);
}

export async function POST(request: Request): Promise<Response> {
  let raw = '';
  try {
    const body = (await request.json()) as { domain?: unknown };
    raw = typeof body.domain === 'string' ? body.domain : '';
  } catch {
    raw = '';
  }
  return handle(raw, request);
}

async function handle(raw: string, request: Request): Promise<Response> {
  const key = clientKey(request);
  const limit = key ? rateLimited(key) : null;

  if (limit?.limited) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: 'Too many analyses from this client. The upstream sources are free, so please go easy.',
      },
      {
        status: 429,
        headers: { ...NO_STORE, 'retry-after': String(limit.retryAfterSeconds) },
      },
    );
  }

  const input = normaliseInput(raw);

  if (input.kind === 'rejected') {
    // A bad input is the one case that is genuinely the caller's fault, so it is a 400. Everything that
    // can go wrong *after* this point still returns 200 with partial results.
    return NextResponse.json(
      { error: input.reason, message: input.explanation },
      { status: 400, headers: NO_STORE },
    );
  }

  if (input.kind === 'out_of_scope') {
    return NextResponse.json(toOutOfScopeResponse(input), { headers: NO_STORE });
  }

  if (wantsStream(request)) return streamed(input);

  try {
    const result = await analyze(input);

    return NextResponse.json(toAnalyzeResponse(result), { headers: NO_STORE });
  } catch (error) {
    // Reaching here means a bug rather than a source failure, since every collector converts its own
    // failures into a status. Report it as a server error rather than as a verdict about the domain.
    return NextResponse.json(
      { ...FAULT, detail: detailOf(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * The progress form of the same analysis.
 *
 * Only the body framing differs: the analysis, the budgets and the final payload are identical, and the
 * per-source events carry statuses that also appear in that payload. A client that ignored every
 * `source` line would be left with exactly the non-streaming response.
 */
function streamed(input: Extract<NormalisedInput, { kind: 'ok' }>): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Once a byte has been written the status code is already sent, so a fault after that point can
      // only be reported in-band. `error` is the terminal event that says so.
      const send = (event: AnalyzeStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeLine(event)));
        } catch {
          // The client disconnected. The analysis is already in flight and will finish on its own; there
          // is simply nowhere left to report it.
        }
      };

      try {
        const result = await analyze(input, {
          onSource: (status) => send({ type: 'source', ...status }),
        });
        send({ type: 'result', ...toAnalyzeResponse(result) });
      } catch (error) {
        send({ type: 'error', ...FAULT, detail: detailOf(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      ...NO_STORE,
      'content-type': `${NDJSON_MEDIA_TYPE}; charset=utf-8`,
      // Progress that arrives all at once is not progress. Named for nginx, which is the proxy most
      // likely to sit in front of this and buffer a response it thinks it is helping with.
      'x-accel-buffering': 'no',
    },
  });
}

function wantsStream(request: Request): boolean {
  return request.headers.get('accept')?.includes(NDJSON_MEDIA_TYPE) ?? false;
}

const FAULT = {
  error: 'analysis_failed',
  message:
    'The analysis could not be completed. This is a fault in the service, not a finding about the domain.',
} as const;

function detailOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
