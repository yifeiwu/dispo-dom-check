import type { Verdict } from '@/lib/scoring/weights';

/**
 * The verdict at a glance. Confidence stays equally explicit, but as text rather than a second arc that
 * needs a legend to decode.
 */
const VERDICT_COLOURS: Record<Verdict, { arc: string; text: string; ring: string }> = {
  high_risk: { arc: 'stroke-danger', text: 'text-danger', ring: 'ring-danger/30' },
  suspicious: { arc: 'stroke-caution', text: 'text-caution', ring: 'ring-caution/30' },
  unclear: { arc: 'stroke-warn', text: 'text-warn', ring: 'ring-warn/30' },
  probably_legitimate: { arc: 'stroke-probable', text: 'text-probable', ring: 'ring-probable/30' },
  established: { arc: 'stroke-accent', text: 'text-accent', ring: 'ring-accent/30' },
  insufficient_evidence: { arc: 'stroke-ink-faint', text: 'text-ink-muted', ring: 'ring-ink-faint/30' },
  out_of_scope: { arc: 'stroke-ink-faint', text: 'text-ink-muted', ring: 'ring-ink-faint/30' },
};

/** Three quarters of a circle, so the gap reads as a gauge rather than a pie chart. */
const SWEEP = 0.75;
const SCORE_RADIUS = 54;

function arc(radius: number, fraction: number) {
  const circumference = 2 * Math.PI * radius;
  const track = circumference * SWEEP;
  return {
    track,
    dash: `${track * fraction} ${circumference}`,
    trackDash: `${track} ${circumference}`,
  };
}

export function ScoreGauge({
  legitimacy,
  confidence,
  verdict,
  verdictLabel,
}: {
  legitimacy: number;
  confidence: number;
  verdict: Verdict;
  verdictLabel: string;
}) {
  const colours = VERDICT_COLOURS[verdict];
  const score = arc(SCORE_RADIUS, legitimacy / 100);

  // Below the threshold the verdict is withheld, so the arc is dashed to show the score is not standing
  // on much rather than letting it render as solidly as a fully evidenced one.
  const withheld = verdict === 'insufficient_evidence';
  const confidenceLabel = confidence >= 80 ? 'High' : confidence >= 40 ? 'Moderate' : 'Low';

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <div
        className="relative h-[132px] w-[132px] shrink-0"
        role="img"
        aria-label={`Legitimacy ${legitimacy} of 100, confidence ${confidence} of 100. Verdict: ${verdictLabel}.`}
      >
        <svg viewBox="0 0 148 148" className="h-full w-full -rotate-[135deg]" aria-hidden>
          <circle
            cx="74"
            cy="74"
            r={SCORE_RADIUS}
            fill="none"
            className="stroke-edge"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={score.trackDash}
          />
          <circle
            className={`arc-value ${colours.arc}`}
            cx="74"
            cy="74"
            r={SCORE_RADIUS}
            fill="none"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={score.dash}
            strokeOpacity={withheld ? 0.55 : 1}
            style={{ ['--arc-length' as string]: `${score.track}px` }}
          />

        </svg>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-3xl font-semibold tabular-nums ${colours.text}`}>{legitimacy}</span>
          <span className="text-xs uppercase tracking-wide text-ink-faint">legitimacy</span>
        </div>
      </div>

      <div className="min-w-0 text-center sm:text-left">
        <div
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ring-1 ${colours.text} ${colours.ring}`}
        >
          {verdictLabel}
        </div>

        <p className="mt-3 text-sm text-ink-muted">
          {confidenceLabel} confidence <span className="tabular-nums">({confidence}%)</span>
        </p>

        {withheld ? (
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-ink-faint">
            Too little answered to call this either way, so the verdict is withheld rather than guessed.
          </p>
        ) : null}
      </div>
    </div>
  );
}
