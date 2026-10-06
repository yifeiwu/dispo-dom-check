'use client';

import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { SourcePanel } from '@/components/SourcePanel';
import { dimensionLabel } from '@/lib/api-types';
import type { SourceStatus } from '@/lib/facts';
import { signedPoints } from '@/lib/format';
import { glossaryFor } from '@/lib/glossary';
import type { CombinationResult } from '@/lib/scoring/combinations';
import type { ObservationResult } from '@/lib/scoring/observations';
import type { DimensionSubtotal, InapplicableSignal } from '@/lib/scoring/score';
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
/**
 * The wiring that makes a show/hide control announce itself, in one place.
 *
 * Two disclosures render in this file — a signal row and a collapsible group — and they share no
 * markup at all, so this returns props rather than a component. What it centralises is the part that
 * is easy to get wrong and invisible when it is: the panel keeps a stable id and stays mounted while
 * hidden, so `aria-controls` always names an element that exists. Pointing it at a conditionally
 * rendered panel is the usual way this pattern breaks, and it leaves a screen reader announcing a
 * control over a missing target. Written twice, it only has to be corrected once to start differing.
 */
function useDisclosure(open: boolean) {
  const panelId = useId();
  return {
    triggerProps: { 'aria-expanded': open, 'aria-controls': panelId },
    panelProps: { id: panelId, hidden: !open },
  };
}

function Points({ points }: { points: number }) {
  const tone = points > 0 ? 'text-accent' : points < 0 ? 'text-danger' : 'text-ink-faint';
  return (
    <span className={`shrink-0 tabular-nums text-sm font-medium ${tone}`}>
      {signedPoints(Math.round(points * 10) / 10)}
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
      {/* The tab change is visible to a sighted reader the moment it happens and to nobody else, so it
          is said here rather than left as a surprise. */}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * Controlled rather than holding its own `open`, so that expansion survives the next analysis.
 *
 * The state lives in the parent keyed by signal id, which is what makes comparing two domains
 * possible: open the three rows you care about, analyse the next domain, and the same three rows are
 * already open if they fired again. Per-row state closed everything on every query, which made the
 * audit trail unusable for exactly the job it exists for.
 */
function Row({
  label,
  rationale,
  evidence,
  points,
  sourceUrl,
  tag,
  open,
  onToggle,
}: {
  label: string;
  rationale: string;
  evidence: string;
  points: number;
  sourceUrl?: string;
  tag?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { triggerProps, panelProps } = useDisclosure(open);

  return (
    <li className="rise border-b border-edge last:border-0">
      <button
        type="button"
        onClick={onToggle}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-white/[0.03]"
        {...triggerProps}
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
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs uppercase tracking-wide text-ink-faint">
                {tag}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-sm text-ink-muted">{evidence}</span>
        </span>
        <Points points={points} />
      </button>

      <div {...panelProps} className="pb-4 pl-6 pr-2">
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
  const { triggerProps, panelProps } = useDisclosure(open);
  const descriptionId = useId();

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-sm text-ink-muted underline decoration-dotted underline-offset-4 hover:text-ink"
        {...triggerProps}
        aria-describedby={descriptionId}
      >
        {summary(open)}
      </button>
      {/* Associated with the control rather than merely sitting under it, since it is the sentence that
          says what opening the group would get you. */}
      <p id={descriptionId} className="mt-1 text-sm text-ink-faint">
        {description}
      </p>
      <div {...panelProps}>{children}</div>
    </section>
  );
}

/** What a row is worth, ignoring direction. The counterpart of `magnitude` on the how-it-works page,
 *  which orders the same heuristics by the most they could ever move a score rather than by what they
 *  moved this one. */
const magnitude = (points: number): number => Math.abs(points);

export function SignalRows({
  signals,
  combinations,
  observations,
  inapplicable,
  dimensions,
  sources,
  elapsedMs,
}: {
  signals: SignalResult[];
  combinations: CombinationResult[];
  observations: ObservationResult[];
  inapplicable: InapplicableSignal[];
  dimensions: DimensionSubtotal[];
  sources: SourceStatus[];
  elapsedMs: number;
}) {
  const scoring = signals.filter((signal) => signal.points !== 0);
  const findings = [
    ...combinations.map((entry) => ({ ...entry, sourceUrl: undefined, tag: 'Combination' })),
    ...scoring.map((entry) => ({
      ...entry,
      tag: dimensionLabel(entry.dimension),
    })),
  ].sort((a, b) => magnitude(b.points) - magnitude(a.points));
  const topFindings = findings.slice(0, 3);
  const [showAll, setShowAll] = useState(false);

  /**
   * Which rows are open, keyed by signal id and deliberately outliving a re-query.
   *
   * A set rather than a map of booleans because the only question ever asked of it is membership, and
   * an absent id and a `false` one would otherwise be two spellings of closed.
   */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setOpened((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

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
        tag: dimensionLabel(signal.dimension),
      })),
    ...observations.map((observation) => ({ ...observation, tag: 'Never scored' })),
  ];

  /*
   * Read off the strings that were actually rendered, rather than from a list of terms attached to each
   * signal, so that rewording a piece of evidence carries its own vocabulary with it and a signal that
   * stops mentioning DMARC stops offering to explain it.
   */
  const terms = useMemo(
    () =>
      glossaryFor([
        ...signals.flatMap((signal) => [signal.label, signal.evidence, signal.rationale]),
        ...observations.flatMap((entry) => [entry.label, entry.evidence, entry.rationale]),
        ...combinations.flatMap((entry) => [entry.label, entry.evidence, entry.rationale]),
        ...inapplicable.flatMap((entry) => [entry.label, entry.rationale]),
      ]),
    [signals, observations, combinations, inapplicable],
  );

  /*
   * Heaviest first, both between sections and within them.
   *
   * The how-it-works page already orders the registry this way and says why: it puts the heuristics
   * that decide most verdicts at the top. That argument is stronger here, where the numbers are a real
   * domain's rather than the model's outer limits, and the payload order it replaced was an artefact of
   * the order the scorer happens to evaluate in. Sections rank on the clamped subtotal, which is the
   * dimension's actual contribution after its limit was applied rather than before.
   *
   * Sorting is stable, so heuristics of equal weight keep the registry order behind these comparisons.
   */
  // Keyed loosely, because the sections are grouped by the `dimension` string a signal actually
  // carried, which is what the rest of this component already renders whatever the payload held.
  const subtotal = new Map<string, number>(
    dimensions.map((entry) => [entry.dimension, magnitude(entry.clamped)]),
  );

  const byDimension = new Map<string, SignalResult[]>();
  for (const signal of scoring) {
    const bucket = byDimension.get(signal.dimension) ?? [];
    bucket.push(signal);
    byDimension.set(signal.dimension, bucket);
  }

  const sections = [...byDimension.entries()]
    .map(([dimension, rows]) => ({
      dimension,
      rows: [...rows].sort((a, b) => magnitude(b.points) - magnitude(a.points)),
    }))
    .sort((a, b) => (subtotal.get(b.dimension) ?? 0) - (subtotal.get(a.dimension) ?? 0));

  const sourceProblems = sources.filter((source) =>
    ['timeout', 'rate_limited', 'unavailable'].includes(source.status),
  );

  return (
    <div className="space-y-6">
      {findings.length > 0 ? (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold">
              {showAll ? 'All scored findings' : 'Top reasons'}
            </h3>
            {findings.length > 3 ? (
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="text-sm text-ink-muted underline decoration-dotted underline-offset-4 hover:text-ink"
              >
                {showAll ? 'Show top reasons' : `View all ${findings.length} findings`}
              </button>
            ) : null}
          </div>

          {!showAll ? (
            <ul className="rounded-lg border border-edge bg-surface-raised px-4">
              {topFindings.map((finding) => (
                <Row
                  key={finding.id}
                  label={finding.label}
                  rationale={finding.rationale}
                  evidence={finding.evidence}
                  points={finding.points}
                  sourceUrl={finding.sourceUrl}
                  tag={finding.tag}
                  open={opened.has(finding.id)}
                  onToggle={() => toggle(finding.id)}
                />
              ))}
            </ul>
          ) : (
            <div className="space-y-5">
              {combinations.length > 0 ? (
                <section>
                  <h4 className="mb-2 text-sm font-medium text-ink-muted">Combinations</h4>
                  <ul className="rounded-lg border border-edge bg-surface-raised px-4">
                    {combinations.map((combination) => (
                      <Row
                        key={combination.id}
                        label={combination.label}
                        rationale={combination.rationale}
                        evidence={combination.evidence}
                        points={combination.points}
                        tag={combination.mode}
                        open={opened.has(combination.id)}
                        onToggle={() => toggle(combination.id)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {sections.map(({ dimension, rows }) => (
                <section key={dimension}>
                  <h4 className="mb-2 text-sm font-medium text-ink-muted">
                    {dimensionLabel(dimension)}
                  </h4>
                  <ul className="rounded-lg border border-edge bg-surface-raised px-4">
                    {rows.map((signal) => (
                      <Row
                        key={signal.id}
                        label={signal.label}
                        rationale={signal.rationale}
                        evidence={signal.evidence}
                        points={signal.points}
                        sourceUrl={signal.sourceUrl}
                        open={opened.has(signal.id)}
                        onToggle={() => toggle(signal.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>
      ) : (
        <p className="text-sm text-ink-muted">No finding moved the score.</p>
      )}

      {sourceProblems.length > 0 ? (
        <p className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
          {sourceProblems.length} {sourceProblems.length === 1 ? 'source did' : 'sources did'} not
          answer, so confidence may be lower. See technical details for status.
        </p>
      ) : null}

      <Collapsible
        summary={(open) => (open ? 'Hide technical details' : 'Technical details')}
        description={`${sourceProblems.length > 0 ? 'Some sources need attention' : 'No source problems'} · completed in ${elapsedMs} ms`}
      >
        <div className="mt-4 space-y-6 rounded-lg border border-dashed border-edge p-4">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Sources</h3>
            <SourcePanel sources={sources} />
          </section>

          {unscored.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">
                Other observations <span className="font-normal text-ink-faint">({unscored.length})</span>
              </h3>
              <p className="text-sm text-ink-faint">Observed, but did not move the score.</p>
              <ul className="rounded-lg border border-edge px-4">
                {unscored.map((entry) => (
                  <Row
                    key={entry.id}
                    label={entry.label}
                    rationale={entry.rationale}
                    evidence={entry.evidence}
                    points={0}
                    sourceUrl={entry.sourceUrl}
                    tag={entry.tag}
                    open={opened.has(entry.id)}
                    onToggle={() => toggle(entry.id)}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {inapplicable.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">
                Not applicable <span className="font-normal text-ink-faint">({inapplicable.length})</span>
              </h3>
              <ul className="space-y-2">
                {inapplicable.map((signal) => (
                  <li key={signal.id} className="text-sm">
                    <span className="text-ink-muted">{signal.label}</span>
                    <span className="mt-0.5 block text-ink-faint">{signal.rationale}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {terms.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Glossary</h3>
              <dl className="space-y-3">
                {terms.map((entry) => (
                  <div key={entry.term}>
                    <dt className="text-sm font-medium">{entry.term}</dt>
                    <dd className="mt-0.5 text-sm leading-relaxed text-ink-muted">
                      {entry.definition}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </div>
      </Collapsible>
    </div>
  );
}
