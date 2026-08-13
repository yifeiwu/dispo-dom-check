import { DIMENSION_LABELS } from '@/lib/api-types';
import { signedPoints } from '@/lib/format';
import type { DimensionSubtotal } from '@/lib/scoring/score';

/**
 * Per-dimension subtotals, drawn against each dimension's own clamp.
 *
 * The clamp is shown rather than hidden because it is load-bearing: a dimension that hit its limit was
 * prevented from carrying the verdict alone, and that is a fact about the score a reader should be able
 * to see. It is stated in a footnote rather than a `title` tooltip so it survives touch and keyboards.
 */
export function DimensionBars({ dimensions }: { dimensions: DimensionSubtotal[] }) {
  const scored = dimensions.filter((dimension) => dimension.clamped !== 0);
  if (scored.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No dimension scored either way, which usually means very little was observable.
      </p>
    );
  }

  // One shared scale across dimensions, so bar lengths are comparable rather than each self-normalised.
  const extent = Math.max(...dimensions.map((d) => Math.max(Math.abs(d.clamp.min), d.clamp.max)));

  // A centred axis costs half the width to show a negative side that most domains never use, so it is
  // only drawn once something is actually negative.
  const diverging = scored.some((dimension) => dimension.clamped < 0);
  const capped = scored.filter((dimension) => dimension.clampApplied);

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {scored.map((dimension) => {
          const negative = dimension.clamped < 0;
          const width = (Math.abs(dimension.clamped) / extent) * (diverging ? 50 : 100);

          return (
            <li
              key={dimension.dimension}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[9.5rem_minmax(0,1fr)_3.5rem] sm:gap-y-0"
            >
              {/* Wraps rather than truncates: the column is narrower than "Registration economics" and
                  an ellipsis here would hide which dimension the bar beside it belongs to. */}
              <span className="text-xs text-ink-muted sm:col-start-1">
                {DIMENSION_LABELS[dimension.dimension] ?? dimension.dimension}
              </span>

              <span className="relative col-span-2 row-start-2 flex h-4 items-center sm:col-span-1 sm:col-start-2 sm:row-start-1">
                {diverging ? <span className="absolute left-1/2 h-full w-px bg-edge" /> : null}
                <span
                  className={`absolute h-2 rounded-sm ${negative ? 'bg-danger/70' : 'bg-accent/70'}`}
                  style={
                    negative
                      ? { right: '50%', width: `${width}%` }
                      : { left: diverging ? '50%' : 0, width: `${width}%` }
                  }
                />
              </span>

              <span className="col-start-2 row-start-1 text-right text-xs tabular-nums sm:col-start-3">
                {signedPoints(dimension.clamped)}
                {dimension.clampApplied ? <span className="ml-0.5 text-ink-faint">*</span> : null}
              </span>
            </li>
          );
        })}
      </ul>

      {capped.length > 0 ? (
        <p className="text-sm leading-relaxed text-ink-faint">
          <span aria-hidden>* </span>
          {capped.length === 1
            ? `${DIMENSION_LABELS[capped[0].dimension] ?? capped[0].dimension} reached its limit and was cut from ${capped[0].raw} to ${capped[0].clamped}.`
            : `${capped.length} dimensions reached their limit and were cut back.`}{' '}
          Every dimension is capped so that no single one can decide the verdict alone.
        </p>
      ) : null}
    </div>
  );
}
