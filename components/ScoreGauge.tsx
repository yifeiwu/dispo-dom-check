import { bandPosition, VERDICT_LABELS } from '@/lib/scoring/verdict';
import { DEFAULT_CONFIG, type Verdict } from '@/lib/scoring/weights';

/**
 * Two numbers, never one: the score and how much evidence stands behind it.
 *
 * Confidence is drawn as a second arc concentric with the score rather than as a statistic beside it,
 * because a mid-range score with thin coverage means something entirely different from the same score
 * with every source answering, and a reader who takes in only the large number will not know which they
 * have. Putting both in the same glance is the only way the second number does its job.
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
const CONFIDENCE_RADIUS = 40;

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
  const coverage = arc(CONFIDENCE_RADIUS, confidence / 100);

  // Below the threshold the verdict is withheld, so the arc is dashed to show the score is not standing
  // on much rather than letting it render as solidly as a fully evidenced one.
  const withheld = verdict === 'insufficient_evidence';

  /*
   * A band is a range, and its name alone hides where in that range the domain fell. A 69 and a 55
   * are both "Probably legitimate"; only one of them is a point away from being called something else,
   * and that is the thing worth knowing before deciding how much friction a signup deserves.
   *
   * Withheld verdicts get none of this: the band they would fall in is exactly the guess the
   * confidence floor exists to refuse.
   */
  const band = withheld ? undefined : bandPosition(legitimacy, DEFAULT_CONFIG);

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <div
        className="relative h-[148px] w-[148px] shrink-0"
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

          <circle
            cx="74"
            cy="74"
            r={CONFIDENCE_RADIUS}
            fill="none"
            className="stroke-edge"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={coverage.trackDash}
          />
          <circle
            className="arc-value stroke-ink-muted"
            cx="74"
            cy="74"
            r={CONFIDENCE_RADIUS}
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={coverage.dash}
            style={{ ['--arc-length' as string]: `${coverage.track}px` }}
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

        {band ? (
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-ink-muted">
            <span className="tabular-nums">
              {verdictLabel} runs {band.min} to {band.max}.
            </span>
            {band.nearest ? (
              <>
                {' '}
                <span className="tabular-nums">{band.nearest.distance}</span>{' '}
                {band.nearest.distance === 1 ? 'point' : 'points'}{' '}
                {band.nearest.direction === 'below' ? 'lower' : 'higher'} would read{' '}
                {VERDICT_LABELS[band.nearest.verdict].toLowerCase()}.
              </>
            ) : null}
          </p>
        ) : null}

        <dl className="mt-3 flex justify-center gap-6 text-sm sm:justify-start">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-faint">Risk</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{100 - legitimacy}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
              <span aria-hidden className="h-0.5 w-3 rounded-full bg-ink-muted" />
              Confidence
            </dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-ink-muted">{confidence}</dd>
          </div>
        </dl>

        {withheld ? (
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-ink-faint">
            Too little answered to call this either way, so the verdict is withheld rather than guessed.
          </p>
        ) : null}
      </div>
    </div>
  );
}
