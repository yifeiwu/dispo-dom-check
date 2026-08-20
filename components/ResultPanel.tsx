'use client';

import { DimensionBars } from '@/components/DimensionBars';
import { ScoreGauge } from '@/components/ScoreGauge';
import { SignalRows } from '@/components/SignalRows';
import { SourcePanel } from '@/components/SourcePanel';
import type { AnalyzeResponse, OutOfScopeResponse } from '@/lib/api-types';
import { formatAge, formatDate } from '@/lib/format';

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
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-mono text-base">{result.domain}</h2>
          <span className="text-xs text-ink-faint">{result.elapsedMs} ms</span>
        </div>

        {/*
          The score and its breakdown are one thought, so on a wide screen they sit together rather
          than the reader scrolling from the number to the reason for it. Below `lg` they stack in
          that same order, which is why the breakdown moved into this card: it was already the next
          thing anyone read.
        */}
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start lg:gap-8">
          <ScoreGauge
            legitimacy={result.legitimacy}
            confidence={result.confidence}
            verdict={result.verdict}
            verdictLabel={result.verdictLabel}
          />

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Where the score came from</h3>
            <DimensionBars dimensions={result.dimensions} />
          </section>
        </div>

        <div className="flex flex-col gap-1 border-y border-edge py-3 text-sm sm:flex-row sm:items-baseline sm:gap-3">
          <span className="font-medium">Domain age</span>
          {result.firstSeen && result.ageDays !== undefined ? (
            <>
              <span>{formatAge(result.ageDays)}</span>
              <span className="text-xs text-ink-faint">
                Registered {formatDate(result.firstSeen.date)} · {result.firstSeen.source}
              </span>
            </>
          ) : (
            <span className="text-ink-muted">
              {result.providerSuffix
                ? 'Not applicable to this platform-issued name'
                : 'Unavailable — no registration date was returned'}
            </span>
          )}
        </div>

        {/* Held to a readable measure: the card runs the full width of the page on a large screen,
            and prose set across all of it is tiring to read. Set a step above the surrounding
            chrome, because this is the part of the page anyone actually reads through rather than
            scans. */}
        <p className="max-w-prose text-base leading-relaxed">{result.narrative}</p>
      </section>

      <SignalRows
        signals={result.signals}
        combinations={result.combinations}
        observations={result.observations}
        inapplicable={result.inapplicableSignals}
        dimensions={result.dimensions}
      />

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Sources</h3>
        <SourcePanel sources={result.sources} />
      </section>
    </div>
  );
}
