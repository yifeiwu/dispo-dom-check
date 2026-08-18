'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NDJSON_MEDIA_TYPE,
  isError,
  type AnalyzeResponse,
  type AnalyzeStreamEvent,
  type ApiResult,
  type OutOfScopeResponse,
} from '@/lib/api-types';
import { readHost } from '@/lib/domain-syntax';
import type { SourceStatus } from '@/lib/facts';
import { MalformedLineError, readNdjsonStream } from '@/lib/ndjson';

/**
 * Everything between the input box and a verdict: validation, transport, both body forms, the in-flight
 * request and the address bar.
 *
 * Held apart from the markup because none of it is about how the page looks, and because the parts that
 * are easy to get wrong are all here — which analysis owns the screen when two have been asked for, what
 * a failure is allowed to do to the verdict already on it, and which of those states the URL should
 * describe. The page below renders what this returns and decides nothing.
 */

/**
 * Reads the progress form, reporting each source as it lands and returning the terminal event.
 *
 * A stream that ends without one was cut in transit, which is a fault in the service rather than a
 * finding about the domain, and is reported as such: the reader has just watched several sources answer
 * and must not be left with a blank page implying nothing happened.
 *
 * A line that arrived whole and was not JSON is converted here rather than left to propagate. It would
 * otherwise reach the `catch` in `analyse` and be reported as the request never arriving, which is the
 * one explanation it cannot be — several sources have already been read off the same stream. This is the
 * same distinction `readJson` draws below, for the same reason.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onSource: (status: SourceStatus) => void,
): Promise<ApiResult> {
  let terminal: ApiResult | undefined;

  try {
    await readNdjsonStream<AnalyzeStreamEvent>(body, (event) => {
      if (event.type === 'source') onSource(event);
      else terminal = event;
    });
  } catch (error) {
    // Anything else is the connection itself failing, which `analyse` classifies correctly already.
    if (!(error instanceof MalformedLineError)) throw error;

    return {
      error: 'malformed_response',
      message:
        'The service sent a response that could not be read. This is a fault in the service, not a finding about the domain.',
    };
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
export type Failure = { kind: 'network' | 'service' | 'input'; message: string };

export type Analysis = {
  /** What the box says. Owned here because arriving via the address bar has to fill it in. */
  input: string;
  setInput: (value: string) => void;
  /** The last result worth displaying, whether or not it still answers the question in the box. */
  result: AnalyzeResponse | OutOfScopeResponse | null;
  /** The domain that result describes. */
  resultQuery: string | null;
  /** The domain last asked about, which is what `result` is stale against. */
  submitted: string | null;
  pending: boolean;
  failure: Failure | null;
  /** Sources that have reported so far in the analysis now running. */
  settled: SourceStatus[];
  /** The displayed verdict no longer answers the question in the box. */
  stale: boolean;
  analyse: (raw: string, history?: HistoryMode) => Promise<void>;
  cancel: () => void;
};

export function useAnalysis(): Analysis {
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

  const cancel = useCallback(() => inFlight.current?.abort(), []);

  return {
    input,
    setInput,
    result,
    resultQuery,
    submitted,
    pending,
    failure,
    settled,
    /**
     * The displayed verdict no longer answers the question in the box, because the analysis that would
     * have replaced it failed or was cancelled. It stays, since a comparison point is worth keeping, but
     * it says whose verdict it is.
     */
    stale: result !== null && resultQuery !== submitted,
    analyse,
    cancel,
  };
}
