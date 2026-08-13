'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DimensionBars } from '@/components/DimensionBars';
import { ScoreGauge } from '@/components/ScoreGauge';
import { SignalRows } from '@/components/SignalRows';
import { SourcePanel, SourceProgress } from '@/components/SourcePanel';
import {
  FLAG_LABELS,
  NDJSON_MEDIA_TYPE,
  isError,
  isOutOfScope,
  type AnalyzeStreamEvent,
  type ApiResult,
} from '@/lib/api-types';
import type { SourceStatus } from '@/lib/facts';
import { createLineParser } from '@/lib/ndjson';

/**
 * Examples chosen to span the model rather than to flatter it: an established business, a disposable
 * mailbox service and an alias forwarder. The empty state is the only chance to show that the tool
 * discriminates, and a reader who has seen the range trusts a single verdict far more.
 */
const EXAMPLES = [
  { domain: 'github.com', hint: 'established' },
  { domain: 'mailinator.com', hint: 'disposable' },
  { domain: 'simplelogin.io', hint: 'forwarder' },
];

function formatAge(days: number): string {
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 730) {
    const months = Math.round(days / 30.44);
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  const years = Math.round((days / 365.25) * 10) / 10;
  return `${years} year${years === 1 ? '' : 's'}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/**
 * Reads the progress form, reporting each source as it lands and returning the terminal event.
 *
 * A stream that ends without one was cut in transit, which is a fault in the service rather than a
 * finding about the domain, and is reported as such: the reader has just watched several sources answer
 * and must not be left with a blank page implying nothing happened.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onSource: (status: SourceStatus) => void,
): Promise<ApiResult> {
  const reader = body.getReader();
  // Decoded here rather than through `TextDecoderStream` so that `stream: true` carries a multi-byte
  // character split across two chunks, which a per-chunk decode would turn into a replacement character.
  const decoder = new TextDecoder();
  const parser = createLineParser<AnalyzeStreamEvent>();
  let terminal: ApiResult | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (event.type === 'source') onSource(event);
        else terminal = event;
      }
    }
  } finally {
    parser.flush();
    reader.releaseLock();
  }

  return (
    terminal ?? {
      error: 'incomplete_response',
      message: 'The connection closed before the analysis finished. Try again.',
    }
  );
}

/**
 * Reads the single-object form, which is also every rejection the endpoint can return.
 *
 * `response.json()` is not enough on its own. A gateway timing out or a platform error page answers with
 * HTML, which throws here and would otherwise surface as "check your connection" — blaming the reader's
 * network for a fault on this side.
 */
async function readJson(response: Response): Promise<ApiResult> {
  try {
    return (await response.json()) as ApiResult;
  } catch {
    return {
      error: 'unreadable_response',
      message: response.ok
        ? 'The service returned a response that could not be read.'
        : `The service returned HTTP ${response.status} and no explanation. This is a fault in the service, not a finding about the domain.`,
    };
  }
}

export default function Home() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<ApiResult | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [settled, setSettled] = useState<SourceStatus[]>([]);
  const restored = useRef(false);

  const analyse = useCallback(async (raw: string) => {
    const query = raw.trim();
    if (!query) return;

    setPending(true);
    setFailure(null);
    setSettled([]);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Progress if the service will stream it, one object if it will not. The fallback matters:
          // the endpoint answers every rejection with a plain body whatever was asked for.
          accept: `${NDJSON_MEDIA_TYPE}, application/json`,
        },
        body: JSON.stringify({ domain: query }),
      });

      const stream = (response.headers.get('content-type') ?? '').includes(NDJSON_MEDIA_TYPE)
        ? response.body
        : null;

      const payload = stream
        ? await readStream(stream, (status) => setSettled((seen) => [...seen, status]))
        : await readJson(response);

      setResult(payload);
      // A verdict is something you paste to a colleague, so the query belongs in the URL.
      window.history.replaceState(null, '', `?domain=${encodeURIComponent(query)}`);
    } catch {
      setFailure('The request could not be completed. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const initial = new URLSearchParams(window.location.search).get('domain');
    if (initial) {
      setInput(initial);
      void analyse(initial);
    }
  }, [analyse]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    void analyse(input);
  }

  const showResult = result && !isError(result) && !isOutOfScope(result) ? result : null;

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="domain" className="block text-sm font-medium">
          Domain or email address
        </label>
        <div className="flex gap-2">
          <input
            id="domain"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="a domain, or a full address"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-sunken px-3 py-2.5 font-mono text-sm outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-accent/50"
          />
          <button
            type="submit"
            disabled={pending || !input.trim()}
            aria-busy={pending}
            // Dimmed enough to read as unavailable, not so far that the label stops meeting contrast.
            // At 40% this was the least legible text on the page, and it is the one control that tells a
            // first-time reader what the page does.
            className="shrink-0 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-surface transition-opacity disabled:opacity-70"
          >
            {pending ? 'Analysing' : 'Analyse'}
          </button>
        </div>
        <p className="text-xs text-ink-faint">
          If you paste an address, everything before the @ is removed.
        </p>
      </form>

      {!result && !pending ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-ink-muted">Or try one of these</h2>
          <ul className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <li key={example.domain}>
                <button
                  type="button"
                  onClick={() => {
                    setInput(example.domain);
                    void analyse(example.domain);
                  }}
                  className="flex items-baseline gap-2 rounded-full border border-edge bg-surface-raised px-3 py-1.5 text-sm transition-colors hover:border-accent/40"
                >
                  <span className="font-mono">{example.domain}</span>
                  <span className="text-xs text-ink-faint">{example.hint}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="max-w-2xl text-xs leading-relaxed text-ink-faint">
            All three are real, functioning businesses. The model is not asking whether a domain is
            malicious, but whether it can mint unlimited deliverable addresses cheaply, so the interesting
            part is which dimension each one loses points on.
          </p>
        </section>
      ) : null}

      {/* Announced rather than merely drawn, so the result is not silent for a screen reader. */}
      <p aria-live="polite" className="sr-only">
        {pending ? 'Analysing' : showResult ? `${showResult.domain}: ${showResult.verdictLabel}` : ''}
      </p>

      {failure ? (
        <p className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {failure}
        </p>
      ) : null}

      {pending ? (
        <section className="space-y-3 rounded-xl border border-edge bg-surface-raised p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-ink-muted">
              Sources that do not answer in time are reported rather than waited on.
            </p>
            <Elapsed />
          </div>
          <SourceProgress settled={settled} />
        </section>
      ) : null}

      {result && isError(result) ? (
        <p className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
          {result.message}
        </p>
      ) : null}

      {result && isOutOfScope(result) ? (
        <section className="rise space-y-3 rounded-xl border border-edge bg-surface-raised p-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-mono text-base">{result.domain}</h2>
            <span className="rounded-full px-3 py-1 text-sm text-ink-muted ring-1 ring-ink-faint/30">
              {result.verdictLabel}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-ink-muted">{result.outOfScope.explanation}</p>
        </section>
      ) : null}

      {showResult ? (
        // The previous verdict stays on screen while the next one loads, dimmed rather than discarded,
        // so re-querying does not blank the page and cost the reader their point of comparison.
        <div
          className={`rise space-y-8 transition-opacity ${pending ? 'pointer-events-none opacity-40' : ''}`}
          aria-busy={pending}
        >
          <section className="space-y-5 rounded-xl border border-edge bg-surface-raised p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-mono text-base">{showResult.domain}</h2>
              <span className="text-xs text-ink-faint">
                {showResult.elapsedMs} ms · model {showResult.modelVersion}
              </span>
            </div>

            {/*
              The score and its breakdown are one thought, so on a wide screen they sit together rather
              than the reader scrolling from the number to the reason for it. Below `lg` they stack in
              that same order, which is why the breakdown moved into this card: it was already the next
              thing anyone read.
            */}
            <div className="grid gap-6 lg:grid-cols-2 lg:items-start lg:gap-8">
              <ScoreGauge
                legitimacy={showResult.legitimacy}
                confidence={showResult.confidence}
                verdict={showResult.verdict}
                verdictLabel={showResult.verdictLabel}
              />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Where the score came from</h3>
                <DimensionBars dimensions={showResult.dimensions} />
              </section>
            </div>

            <div className="flex flex-col gap-1 border-y border-edge py-3 text-sm sm:flex-row sm:items-baseline sm:gap-3">
              <span className="font-medium">Domain age</span>
              {showResult.firstSeen && showResult.ageDays !== undefined ? (
                <>
                  <span>{formatAge(showResult.ageDays)}</span>
                  <span className="text-xs text-ink-faint">
                    Registered {formatDate(showResult.firstSeen.date)} · {showResult.firstSeen.source}
                  </span>
                </>
              ) : (
                <span className="text-ink-muted">
                  {showResult.providerSuffix
                    ? 'Not applicable to this platform-issued name'
                    : 'Unavailable — no registration date was returned'}
                </span>
              )}
            </div>

            {/* Held to a readable measure: the card runs the full width of the page on a large screen,
                and prose set across all of it is tiring to read. */}
            <p className="max-w-prose text-sm leading-relaxed">{showResult.narrative}</p>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
              {showResult.verdictDescription}
            </p>

            {showResult.flags.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {showResult.flags.map((flag) => (
                  <li
                    key={flag}
                    className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-muted"
                  >
                    {FLAG_LABELS[flag] ?? flag}
                  </li>
                ))}
              </ul>
            ) : null}

            {showResult.inputWasEmailAddress ? (
              <p className="text-xs text-ink-faint">
                An address was submitted. Only {showResult.domain} was analysed.
              </p>
            ) : null}
          </section>

          <SignalRows
            signals={showResult.signals}
            combinations={showResult.combinations}
            observations={showResult.observations}
            inapplicable={showResult.inapplicableSignals}
          />

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Sources</h3>
            <p className="text-xs text-ink-muted">
              Missing data can never make a domain look worse. A source that fails lowers confidence and
              contributes nothing to the score.
            </p>
            <SourcePanel sources={showResult.sources} />
          </section>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Seconds since the analysis started.
 *
 * Mounted only while one is running, so its own lifetime is the measurement and there is nothing to
 * reset between queries. It earns its place because the source list can legitimately sit still for
 * several seconds while a slow registry is queried, and without a clock a reader cannot tell a slow
 * analysis from a page that has stopped doing anything.
 */
function Elapsed() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(timer);
  }, []);

  return <span className="text-xs tabular-nums text-ink-faint">{seconds}s</span>;
}
