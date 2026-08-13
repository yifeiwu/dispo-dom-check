'use client';

import { useId, useState, type ReactNode } from 'react';
import { DIMENSION_LABELS } from '@/lib/api-types';
import type { CombinationResult } from '@/lib/scoring/combinations';
import type { ObservationResult } from '@/lib/scoring/observations';
import type { SignalResult } from '@/lib/scoring/signals';

/**
 * The explanation layer.
 *
 * Each row separates two things that are easy to conflate: the heuristic and why it exists, which is
 * fixed, and what was actually observed for this domain, which is not. A reader who disagrees with a
 * verdict needs both to tell a wrong observation from a weight they would set differently.
 *
 * The rows are split three ways rather than listed together, because a heuristic that moved the score,
 * one that was reported without ever being scored, and one that never had anything to measure are three
 * different claims, and only the first is asking for the reader's attention.
 */
function Points({ points }: { points: number }) {
  const tone = points > 0 ? 'text-accent' : points < 0 ? 'text-danger' : 'text-ink-faint';
  return (
    <span className={`shrink-0 tabular-nums text-sm font-medium ${tone}`}>
      {points > 0 ? '+' : ''}
      {Math.round(points * 10) / 10}
    </span>
  );
}

/**
 * Where the observation came from.
 *
 * Not every source is a web address. A registration record read over port 43 is identified by a
 * `whois://` pseudo-URL, which names the exact server that answered and is worth showing for that reason,
 * but no browser can follow it. Rendering it as a link would offer the reader something that does nothing
 * when clicked, so only http sources become links and the rest stay as text.
 */
function Source({ url }: { url: string }) {
  const followable = url.startsWith('https://') || url.startsWith('http://');
  const style = 'mt-2 inline-block break-all text-xs text-ink-faint';

  if (!followable) return <span className={style}>{url}</span>;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={`${style} underline decoration-dotted underline-offset-2 hover:text-ink-muted`}
    >
      {url}
    </a>
  );
}

function Row({
  label,
  rationale,
  evidence,
  points,
  sourceUrl,
  tag,
}: {
  label: string;
  rationale: string;
  evidence: string;
  points: number;
  sourceUrl?: string;
  tag?: string;
}) {
  const [open, setOpen] = useState(false);
  // The panel stays mounted and hidden rather than being conditionally rendered, so `aria-controls`
  // always names an element that exists. Pointing it at nothing while collapsed is the usual way this
  // pattern is got wrong, and it leaves a screen reader announcing a control over a missing target.
  const panelId = useId();

  return (
    <li className="rise border-b border-edge last:border-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-white/[0.03]"
        aria-expanded={open}
        aria-controls={panelId}
      >
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`mt-1 h-3 w-3 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4.5 2.5 8.5 6l-4 3.5" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium">{label}</span>
            {tag ? (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                {tag}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-sm text-ink-muted">{evidence}</span>
        </span>
        <Points points={points} />
      </button>

      <div id={panelId} hidden={!open} className="pb-4 pl-6 pr-2">
        <p className="text-sm leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">Why this matters. </span>
          {rationale}
        </p>
        {sourceUrl ? <Source url={sourceUrl} /> : null}
      </div>
    </li>
  );
}

/**
 * A group the reader opens only if they want it. Both the unscored and the inapplicable heuristics
 * belong here: each is worth being able to audit and neither should compete for attention with the
 * rows that moved the score.
 */
function Collapsible({
  summary,
  description,
  children,
}: {
  summary: (open: boolean) => string;
  description: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-sm text-ink-muted underline decoration-dotted underline-offset-4 hover:text-ink"
        aria-expanded={open}
        aria-controls={panelId}
      >
        {summary(open)}
      </button>
      <p className="mt-1 text-xs text-ink-faint">{description}</p>
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

export function SignalRows({
  signals,
  combinations,
  observations,
  inapplicable,
}: {
  signals: SignalResult[];
  combinations: CombinationResult[];
  observations: ObservationResult[];
  inapplicable: { id: string; label: string; rationale: string }[];
}) {
  const scoring = signals.filter((signal) => signal.points !== 0);

  /*
   * Everything that was measured and charged nothing, which is a third state between a heuristic that
   * moved the score and one that never ran. Leaving these in their dimensions made the sections read as
   * though a fact had been weighed when nothing had been charged for it either way.
   *
   * Two things land here for different reasons, and the tag says which. A heuristic that could have
   * scored and came out at zero for this domain is a measurement; an observation is never scored for
   * any domain, by construction. Both are worth auditing and neither is worth the reader's attention
   * before the rows that decided the verdict.
   */
  const unscored = [
    ...signals
      .filter((signal) => signal.points === 0)
      .map((signal) => ({
        ...signal,
        tag: DIMENSION_LABELS[signal.dimension] ?? signal.dimension,
      })),
    ...observations.map((observation) => ({ ...observation, tag: 'Never scored' })),
  ];

  const byDimension = new Map<string, SignalResult[]>();
  for (const signal of scoring) {
    const bucket = byDimension.get(signal.dimension) ?? [];
    bucket.push(signal);
    byDimension.set(signal.dimension, bucket);
  }

  return (
    <div className="space-y-6">
      {combinations.length > 0 ? (
        <section>
          <h3 className="mb-1 text-sm font-semibold">Combinations</h3>
          <p className="mb-2 text-xs text-ink-muted">
            Where the whole differs from the sum of the parts, in both directions: conjunctions that
            eliminate an innocent explanation, and discounts that stop one underlying fact being charged
            twice.
          </p>
          <ul className="rounded-lg border border-edge bg-surface-raised px-4">
            {combinations.map((combination) => (
              <Row
                key={combination.id}
                label={combination.label}
                rationale={combination.rationale}
                evidence={combination.evidence}
                points={combination.points}
                tag={combination.mode}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {[...byDimension.entries()].map(([dimension, rows]) => (
        <section key={dimension}>
          <h3 className="mb-2 text-sm font-semibold">{DIMENSION_LABELS[dimension] ?? dimension}</h3>
          <ul className="rounded-lg border border-edge bg-surface-raised px-4">
            {rows.map((signal) => (
              <Row
                key={signal.id}
                label={signal.label}
                rationale={signal.rationale}
                evidence={signal.evidence}
                points={signal.points}
                sourceUrl={signal.sourceUrl}
              />
            ))}
          </ul>
        </section>
      ))}

      {unscored.length > 0 ? (
        <Collapsible
          summary={(open) =>
            `${open ? 'Hide' : 'Show'} ${unscored.length} ${unscored.length === 1 ? 'finding' : 'findings'} that did not move the score`}
          description="Each of these was observed and charged nothing. Some are heuristics that measured something and came out neutral; those tagged “never scored” are facts the model reports but deliberately never prices. Most of them the domain asserts about itself with nothing to corroborate it, and the rest were measured against the holdout and found not to tell the two classes apart. Each rationale says which."
        >
          <ul className="mt-3 rounded-lg border border-dashed border-edge px-4">
            {unscored.map((entry) => (
              <Row
                key={entry.id}
                label={entry.label}
                rationale={entry.rationale}
                evidence={entry.evidence}
                points={0}
                sourceUrl={entry.sourceUrl}
                tag={entry.tag}
              />
            ))}
          </ul>
        </Collapsible>
      ) : null}

      {inapplicable.length > 0 ? (
        <Collapsible
          summary={(open) =>
            `${open ? 'Hide' : 'Show'} ${inapplicable.length} ${inapplicable.length === 1 ? 'heuristic' : 'heuristics'} that did not apply`}
          description="A heuristic that did not apply is different from one that scored zero: there was nothing to measure at all, so there is no observation to report."
        >
          <ul className="mt-3 space-y-2 rounded-lg border border-dashed border-edge p-4">
            {inapplicable.map((signal) => (
              <li key={signal.id} className="text-sm">
                <span className="text-ink-muted">{signal.label}</span>
                <span className="mt-0.5 block text-xs text-ink-faint">{signal.rationale}</span>
              </li>
            ))}
          </ul>
        </Collapsible>
      ) : null}
    </div>
  );
}
