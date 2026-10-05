'use client';

import { ScoreGauge } from '@/components/ScoreGauge';
import { SignalRows } from '@/components/SignalRows';
import type { AnalyzeResponse, OutOfScopeResponse } from '@/lib/api-types';

/**
 * An out-of-scope answer is a conclusion about the domain rather than a non-event, so it is rendered as
 * a verdict card of its own rather than as an absence.
 */
export function OutOfScopePanel({
  result,
  veil,
  pending,
}: {
  result: OutOfScopeResponse;
  veil: string;
  pending: boolean;
}) {
  return (
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
  );
}

export function ResultPanel({
  result,
  veil,
  pending,
}: {
  result: AnalyzeResponse;
  veil: string;
  pending: boolean;
}) {
  return (
    // The previous verdict stays on screen while the next one loads, dimmed rather than discarded,
    // so re-querying does not blank the page and cost the reader their point of comparison.
    //
    // `inert` rather than the `pointer-events-none` that used to stand alone here, which blocked the
    // mouse and left a keyboard reader tabbing into dimmed rows belonging to the previous domain.
    <div className={`rise space-y-8 transition-opacity ${veil}`} aria-busy={pending} inert={pending}>
      <section className="space-y-5 rounded-xl border border-edge bg-surface-raised p-5">
        <h2 className="font-mono text-base">{result.domain}</h2>

        {/*
          Keep the verdict and its plain-language explanation together. The detailed score audit lives
          below, rather than repeating the same evidence here as bars, facts and rows.
        */}
        <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-8">
          <ScoreGauge
            legitimacy={result.legitimacy}
            confidence={result.confidence}
            verdict={result.verdict}
            verdictLabel={result.verdictLabel}
          />
          <p className="max-w-prose text-base leading-relaxed">{result.narrative}</p>
        </div>
      </section>

      <SignalRows
        signals={result.signals}
        combinations={result.combinations}
        observations={result.observations}
        inapplicable={result.inapplicableSignals}
        dimensions={result.dimensions}
        sources={result.sources}
        elapsedMs={result.elapsedMs}
      />
    </div>
  );
}
