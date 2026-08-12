import { NextResponse } from 'next/server';
import { analyze, type AnalysisResult } from '@/lib/analyze';
import { normaliseInput, type NormalisedInput } from '@/lib/domain';
import { NDJSON_MEDIA_TYPE, type AnalyzeResponse, type AnalyzeStreamEvent } from '@/lib/api-types';
import { encodeLine } from '@/lib/ndjson';
import { VERDICT_DESCRIPTIONS, VERDICT_LABELS } from '@/lib/scoring/verdict';
import { DEFAULT_CONFIG } from '@/lib/scoring/weights';

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
 * Light in-memory rate limit. Serverless instances are not shared, so this is a courtesy brake against
 * a single client hammering the free upstream APIs rather than a security control. A real limit needs the
 * shared store that the cache interface is already waiting for.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
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

  return recent.length > RATE_LIMIT.maxRequests;
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
  const clientKey =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (rateLimited(clientKey)) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: 'Too many analyses from this client. The upstream sources are free, so please go easy.',
      },
      { status: 429 },
    );
  }

  const input = normaliseInput(raw);

  if (input.kind === 'rejected') {
    // A bad input is the one case that is genuinely the caller's fault, so it is a 400. Everything that
    // can go wrong *after* this point still returns 200 with partial results.
    return NextResponse.json(
      { error: input.reason, message: input.explanation },
      { status: 400 },
    );
  }

  if (input.kind === 'out_of_scope') {
    return NextResponse.json({
      domain: input.domain,
      outOfScope: { reason: input.reason, explanation: input.explanation },
      verdict: 'out_of_scope',
      verdictLabel: VERDICT_LABELS.out_of_scope,
      verdictDescription: VERDICT_DESCRIPTIONS.out_of_scope,
      modelVersion: DEFAULT_CONFIG.modelVersion,
    });
  }

  if (wantsStream(request)) return streamed(input);

  try {
    const result = await analyze(input);

    return NextResponse.json(toResponse(result), {
      // Never cached: a fresh lookup per request is the current requirement, and a stale verdict on a
      // domain that was clean last week is worse than a slow one.
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    // Reaching here means a bug rather than a source failure, since every collector converts its own
    // failures into a status. Report it as a server error rather than as a verdict about the domain.
    return NextResponse.json({ ...FAULT, detail: detailOf(error) }, { status: 500 });
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
        const result = await analyze(input, undefined, {
          onSource: (status) => send({ type: 'source', ...status }),
        });
        send({ type: 'result', ...toResponse(result) });
      } catch (error) {
        send({ type: 'error', ...FAULT, detail: detailOf(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      'content-type': `${NDJSON_MEDIA_TYPE}; charset=utf-8`,
      'cache-control': 'no-store',
      // Progress that arrives all at once is not progress. Named for nginx, which is the proxy most
      // likely to sit in front of this and buffer a response it thinks it is helping with.
      'x-accel-buffering': 'no',
    },
  });
}

function wantsStream(request: Request): boolean {
  return request.headers.get('accept')?.includes(NDJSON_MEDIA_TYPE) ?? false;
}

/**
 * The success payload, built in one place so the streaming and non-streaming forms of the endpoint
 * cannot drift into describing the same analysis differently.
 */
function toResponse(result: AnalysisResult): AnalyzeResponse {
  return {
    domain: result.domain,
    submittedHost: result.submittedHost,
    // Reported so the UI can state plainly that the local part was discarded and never stored.
    inputWasEmailAddress: result.fromEmailAddress,
    analysedAt: result.analysedAt,
    elapsedMs: result.elapsedMs,
    modelVersion: result.score.modelVersion,
    legitimacy: result.score.legitimacy,
    risk: result.score.risk,
    confidence: result.score.confidence,
    verdict: result.score.verdict,
    verdictLabel: VERDICT_LABELS[result.score.verdict],
    verdictDescription: VERDICT_DESCRIPTIONS[result.score.verdict],
    narrative: result.score.narrative,
    flags: result.score.flags,
    firstSeen: result.score.firstSeen,
    ageDays: result.score.ageDays,
    dimensions: result.score.dimensions,
    signals: result.score.signals,
    inapplicableSignals: result.score.inapplicableSignals,
    combinations: result.score.combinations,
    sources: result.facts.sources,
    providerSuffix: result.facts.meta.providerSuffix,
  };
}

const FAULT = {
  error: 'analysis_failed',
  message:
    'The analysis could not be completed. This is a fault in the service, not a finding about the domain.',
} as const;

function detailOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
