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
  type AnalyzeResponse,
  type AnalyzeStreamEvent,
  type ApiResult,
  type OutOfScopeResponse,
} from '@/lib/api-types';
import { readHost } from '@/lib/domain-syntax';
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

/**
 * Red for a request that never arrived, amber for one the service turned down. The distinction is
 * worth a colour because only the first is plausibly the reader's to fix.
 */
const FAILURE_TONE = {
  network: {
    box: 'border-danger/30 bg-danger/5 text-danger',
    button: 'border-danger/40 hover:bg-danger/10',
  },
  service: {
    box: 'border-warn/30 bg-warn/5 text-warn',
    button: 'border-warn/40 hover:bg-warn/10',
  },
  input: {
    box: 'border-warn/30 bg-warn/5 text-warn',
    button: 'border-warn/40 hover:bg-warn/10',
  },
} as const;

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

/**
 * Where a completed analysis leaves the address bar.
 *
 * `none` is for an analysis the history itself asked for, which must not record the entry it is in the
 * middle of restoring.
 */
type HistoryMode = 'push' | 'none';

/**
 * The URL follows the displayed verdict rather than the input box, so a pasted link always reproduces
 * what its sender was looking at.
 *
 * Pushed rather than replaced, so Back walks the domains analysed in this session. Replacing left the
 * whole session sharing a single entry, which meant Back leapt out of the app from the fifth verdict
 * and the four before it were unreachable. Re-analysing the domain the URL already names is a refresh
 * rather than a new place to go back to, so that case replaces.
 */
function recordHistory(domain: string, mode: HistoryMode) {
  if (mode === 'none') return;

  const current = new URLSearchParams(window.location.search).get('domain');
  const url = `?domain=${encodeURIComponent(domain)}`;

  if (current === domain) window.history.replaceState({ domain }, '', url);
  else window.history.pushState({ domain }, '', url);
}

/**
 * A fault, told apart by whose fault it is.
 *
 * `network` never reached the service, so there is nothing to say about the domain; `service` is the
 * endpoint declining in its own words; `input` never left the browser. They read differently because
 * they ask the reader to do different things, and only the first two are worth trying again.
 */
type Failure = { kind: 'network' | 'service' | 'input'; message: string };

export default function Home() {
  const [input, setInput] = useState('');
  /**
   * The last result worth displaying, and the query it was produced for.
   *
   * They are held apart because a failed analysis must not be able to relabel a standing verdict as
   * being about the domain that just failed. An error replaces neither: it sets `failure`, the verdict
   * stays on screen as the reader's point of comparison, and the mismatch between these two is what
   * marks it as no longer answering the question in the box.
   */
  const [result, setResult] = useState<AnalyzeResponse | OutOfScopeResponse | null>(null);
  const [resultQuery, setResultQuery] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [settled, setSettled] = useState<SourceStatus[]>([]);

  const inFlight = useRef<AbortController | null>(null);
  // Mirrors `submitted` for the history listener, which is registered once and would otherwise close
  // over the value as it was on mount.
  const submittedRef = useRef<string | null>(null);

  const analyse = useCallback(async (raw: string, history: HistoryMode = 'push') => {
    const query = raw.trim();
    if (!query) return;

    /*
     * Rejected here by the same module the endpoint validates with, so a typo is answered instantly
     * and in the same words rather than after a round trip that also spends one of the twenty requests
     * a minute the endpoint allows.
     *
     * Only the checks that need no suffix list: shipping the list to decide whether `.sbs` is real
     * measured at +44 kB on this page's first load, so those rejections stay on the server. See
     * `lib/domain-syntax.ts`.
     *
     * Checked before the abort below, so a mistyped keystroke cannot cancel an analysis that is
     * legitimately running.
     */
    const rejection = readHost(query);
    if (rejection.kind === 'rejected') {
      submittedRef.current = query;
      setSubmitted(query);
      setFailure({ kind: 'input', message: rejection.explanation });
      return;
    }

    // A second analysis abandons the first rather than racing it. Two in flight can only resolve into
    // one verdict, and without this the slower one wins by finishing last.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    submittedRef.current = query;
    setSubmitted(query);
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
        signal: controller.signal,
      });

      const stream = (response.headers.get('content-type') ?? '').includes(NDJSON_MEDIA_TYPE)
        ? response.body
        : null;

      const payload = stream
        ? await readStream(stream, (status) => setSettled((seen) => [...seen, status]))
        : await readJson(response);

      if (controller.signal.aborted) return;

      if (isError(payload)) {
        setFailure({ kind: 'service', message: payload.message });
      } else {
        setResult(payload);
        setResultQuery(query);
        // Recorded only for a result, which is what keeps the address bar and the verdict on screen
        // from ever describing different domains.
        recordHistory(query, history);
      }
    } catch {
      // An abort is the reader cancelling. That is not a fault and has nothing to report.
      if (controller.signal.aborted) return;
      setFailure({
        kind: 'network',
        message: 'The request could not be completed. Check your connection and try again.',
      });
    } finally {
      // Only the analysis still holding the slot may clear it. A superseded one must not switch off a
      // progress view that now belongs to its replacement.
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }, []);

  /**
   * The address bar is an entry point as much as the form is: a pasted `?domain=` runs on arrival, and
   * Back or Forward restores whichever domain that entry named.
   *
   * The guard is the domain last asked for rather than a once-only ref, so returning to the entry
   * already on screen does nothing while genuinely moving between two of them re-runs. A once-only ref
   * could not tell those apart, which is how the URL and the verdict used to drift out of step.
   */
  useEffect(() => {
    const restore = () => {
      const domain = new URLSearchParams(window.location.search).get('domain')?.trim();
      if (!domain || domain === submittedRef.current) return;
      setInput(domain);
      void analyse(domain, 'none');
    };

    restore();
    window.addEventListener('popstate', restore);
    return () => {
      window.removeEventListener('popstate', restore);
      // Nothing is left running for a page the reader has navigated away from. The guard is cleared
      // along with it, because React's development double-mount tears this down and rebuilds it:
      // without the reset, the remounted page would see its own cancelled request as already done and
      // restore nothing.
      inFlight.current?.abort();
      submittedRef.current = null;
    };
  }, [analyse]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    void analyse(input);
  }

  const cancel = useCallback(() => inFlight.current?.abort(), []);

  const showResult = result && !isOutOfScope(result) ? result : null;
  /**
   * The displayed verdict no longer answers the question in the box, because the analysis that would
   * have replaced it failed or was cancelled. It stays, since a comparison point is worth keeping, but
   * it says whose verdict it is.
   */
  const stale = result !== null && resultQuery !== submitted;

  // Dimmed harder while an analysis is running than when one merely failed, because a stale verdict
  // still has to be readable: it is the only thing on the page saying anything at all.
  const veil = pending ? 'pointer-events-none opacity-40' : stale ? 'opacity-60' : '';

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
            aria-describedby="domain-help"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-edge-strong bg-surface-sunken px-3 py-2.5 font-mono text-sm outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-accent/50"
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
        <p id="domain-help" className="text-sm text-ink-faint">
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
                  className="flex items-baseline gap-2 rounded-full border border-edge-strong bg-surface-raised px-3 py-1.5 text-sm transition-colors hover:border-accent/40"
                >
                  <span className="font-mono">{example.domain}</span>
                  <span className="text-xs text-ink-faint">{example.hint}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="max-w-2xl text-sm leading-relaxed text-ink-faint">
            All three are real, functioning businesses. The model is not asking whether a domain is
            malicious, but whether it can mint unlimited deliverable addresses cheaply, so the interesting
            part is which dimension each one loses points on.
          </p>
        </section>
      ) : null}

      {/*
        Announced rather than merely drawn, so the result is not silent for a screen reader. Every
        terminal state a reader can arrive at goes through here except a failure, which is urgent
        enough to interrupt and carries its own `role="alert"` below.

        An out-of-scope answer is announced on the same footing as a scored one, both carrying a
        `verdictLabel`: it is a conclusion about the domain, not a non-event. A stale verdict announces
        nothing, because re-reading the previous domain's result after an analysis of a different one
        just failed would be the audible version of the bug this page had.
      */}
      <p aria-live="polite" className="sr-only">
        {pending ? 'Analysing' : !result || stale ? '' : `${result.domain}: ${result.verdictLabel}`}
      </p>

      {failure ? (
        <div
          role="alert"
          className={`flex flex-wrap items-baseline justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${FAILURE_TONE[failure.kind].box}`}
        >
          <p className="min-w-0">{failure.message}</p>
          {/* Nothing to retry when the input never left the browser: the same text would be rejected
              the same way, so the only useful move is editing it. */}
          {submitted && failure.kind !== 'input' ? (
            <button
              type="button"
              onClick={() => void analyse(submitted)}
              disabled={pending}
              className={`shrink-0 rounded-md border px-2.5 py-1 font-medium transition-colors disabled:opacity-50 ${FAILURE_TONE[failure.kind].button}`}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {pending ? (
        <section className="space-y-3 rounded-xl border border-edge bg-surface-raised p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-ink-muted">
              Sources that do not answer in time are reported rather than waited on.
            </p>
            <span className="flex shrink-0 items-baseline gap-3">
              <Elapsed />
              {/*
                An analysis can legitimately run for the better part of a minute, so a reader who
                mistyped needs a way out that is not waiting for a domain they no longer care about.
              */}
              <button
                type="button"
                onClick={cancel}
                className="rounded-md border border-edge-strong px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
              >
                Cancel
              </button>
            </span>
          </div>
          <SourceProgress settled={settled} />
        </section>
      ) : null}

      {/*
        The verdict on screen is for `resultQuery`, which is not always what the box now says: an
        analysis that failed or was cancelled leaves the previous one standing rather than blanking the
        page. Saying so is the difference between a useful comparison and a misread.
      */}
      {stale && !pending ? (
        <p className="rounded-lg border border-edge bg-surface-raised px-4 py-3 text-sm text-ink-muted">
          Showing the previous result for <span className="font-mono text-ink">{resultQuery}</span>.
          Nothing here is a verdict on <span className="font-mono text-ink">{submitted}</span>.
        </p>
      ) : null}

      {result && isOutOfScope(result) ? (
        <section
          className={`rise space-y-3 rounded-xl border border-edge bg-surface-raised p-5 ${veil}`}
          inert={pending}
        >
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
        //
        // `inert` rather than the `pointer-events-none` that used to stand alone here, which blocked the
        // mouse and left a keyboard reader tabbing into dimmed rows belonging to the previous domain.
        <div className={`rise space-y-8 transition-opacity ${veil}`} aria-busy={pending} inert={pending}>
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
                and prose set across all of it is tiring to read. Set a step above the surrounding
                chrome, because these two paragraphs are the part of the page anyone actually reads
                through rather than scans. */}
            <p className="max-w-prose text-base leading-relaxed">{showResult.narrative}</p>
            <p className="max-w-prose text-base leading-relaxed text-ink-muted">
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
              <p className="text-sm text-ink-faint">
                An address was submitted. Only {showResult.domain} was analysed.
              </p>
            ) : null}
          </section>

          <SignalRows
            signals={showResult.signals}
            combinations={showResult.combinations}
            observations={showResult.observations}
            inapplicable={showResult.inapplicableSignals}
            dimensions={showResult.dimensions}
          />

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Sources</h3>
            <p className="text-sm text-ink-muted">
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
