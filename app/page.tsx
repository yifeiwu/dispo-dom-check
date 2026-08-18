'use client';

import { AnalysisForm } from '@/components/AnalysisForm';
import { Examples } from '@/components/Examples';
import { FailureNotice } from '@/components/FailureNotice';
import { ProgressPanel } from '@/components/ProgressPanel';
import { OutOfScopePanel, ResultPanel } from '@/components/ResultPanel';
import { useAnalysis } from '@/hooks/useAnalysis';
import { isOutOfScope } from '@/lib/api-types';

/**
 * The page is composition and nothing else. Every decision it used to make about which analysis owns
 * the screen, what a failure does to the verdict already on it and what the address bar should say now
 * lives in `useAnalysis`; what each state looks like lives in the components below.
 */
export default function Home() {
  const {
    input,
    setInput,
    result,
    resultQuery,
    submitted,
    pending,
    failure,
    settled,
    stale,
    analyse,
    cancel,
  } = useAnalysis();

  const scored = result && !isOutOfScope(result) ? result : null;

  // Dimmed harder while an analysis is running than when one merely failed, because a stale verdict
  // still has to be readable: it is the only thing on the page saying anything at all.
  const veil = pending ? 'pointer-events-none opacity-40' : stale ? 'opacity-60' : '';

  return (
    <div className="space-y-8">
      <AnalysisForm
        value={input}
        onChange={setInput}
        onSubmit={() => void analyse(input)}
        pending={pending}
      />

      {!result && !pending ? (
        <Examples
          onPick={(domain) => {
            setInput(domain);
            void analyse(domain);
          }}
        />
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
        <FailureNotice
          failure={failure}
          retryable={submitted}
          pending={pending}
          onRetry={(domain) => void analyse(domain)}
        />
      ) : null}

      {pending ? <ProgressPanel settled={settled} onCancel={cancel} /> : null}

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
        <OutOfScopePanel result={result} veil={veil} pending={pending} />
      ) : null}

      {scored ? <ResultPanel result={scored} veil={veil} pending={pending} /> : null}
    </div>
  );
}
