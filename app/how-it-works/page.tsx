import { COMBINATIONS } from '@/lib/scoring/combinations';
import { SIGNALS, type WeightRange } from '@/lib/scoring/signals';
import { VERDICT_DESCRIPTIONS, VERDICT_LABELS } from '@/lib/scoring/verdict';
import { DEFAULT_CONFIG } from '@/lib/scoring/weights';
import { DIMENSION_LABELS } from '@/lib/api-types';
import type { Verdict } from '@/lib/scoring/weights';

/**
 * Rendered from the same objects the scorer evaluates, which is the entire point.
 *
 * Documentation written by hand drifts away from the model within a release or two. Because this page
 * reads the signal registry and the config directly, adding a signal without a rationale or changing a
 * weight is immediately visible here, and `GET /api/model` serves the same content for anyone who wants
 * it as data.
 */
export const dynamic = 'force-static';

const dimensions = Object.keys(DEFAULT_CONFIG.clamps) as (keyof typeof DEFAULT_CONFIG.clamps)[];

const signed = (points: number): string => `${points > 0 ? '+' : ''}${points}`;

/** What the heuristic is worth at its strongest, which is what the list is ordered on. */
const magnitude = (weight: WeightRange): number =>
  Math.max(Math.abs(weight.min), Math.abs(weight.max));

/**
 * What a heuristic is worth, and why a weight of zero is annotated rather than left to speak for itself.
 *
 * A signal weighted at zero is not one that happened to come out neutral for a domain: it is collected
 * and reported because the fact is worth seeing next to a verdict, and it deliberately moves nothing for
 * any domain. A bare `0` in a column of weights reads as the former, so it says which it is.
 *
 * The tier note goes with it. Nine credits were zeroed in 1.3.0 without their tiers being deleted, which
 * left two signals describing a range that no longer varies: `mail.dmarc_policy` still declares itself
 * scored "by how strict the policy is" and `footprint.saas_vendors` "by how many vendors", when both pay
 * the same nothing at every tier.
 */
function describeWeight(weight: WeightRange): string {
  if (weight.min === 0 && weight.max === 0) return '0 · reported, never scored';

  const range =
    weight.min === weight.max ? signed(weight.min) : `${signed(weight.min)} to ${signed(weight.max)}`;
  return weight.note ? `${range} · ${weight.note}` : range;
}

/**
 * Heaviest heuristic first, within each dimension and across them.
 *
 * Ordering by weight rather than by dimension puts the heuristics that decide most verdicts at the top
 * of the section, and it is derived from the config for the same reason everything else on this page is:
 * a retuned weight reorders the list rather than leaving a stale one behind.
 */
const heuristics = dimensions
  .map((dimension) => ({
    dimension,
    signals: SIGNALS.filter((signal) => signal.dimension === dimension)
      .map((signal) => ({ signal, weight: signal.weight(DEFAULT_CONFIG) }))
      .sort((a, b) => magnitude(b.weight) - magnitude(a.weight)),
  }))
  .filter((group) => group.signals.length > 0)
  // Stable, so dimensions whose heaviest signal ties keep the order the clamps declare them in.
  .sort((a, b) => magnitude(b.signals[0].weight) - magnitude(a.signals[0].weight));

function verdictRange(verdict: Verdict): string {
  if (verdict === 'insufficient_evidence') {
    return `Any score · confidence < ${DEFAULT_CONFIG.confidence.insufficientThreshold}`;
  }
  if (verdict === 'out_of_scope') return 'No score';

  const index = DEFAULT_CONFIG.verdictBands.findIndex((band) => band.verdict === verdict);
  if (index === -1) return 'No configured range';

  const minimum = index === 0 ? 0 : DEFAULT_CONFIG.verdictBands[index - 1].maxScore + 1;
  return `${minimum}–${DEFAULT_CONFIG.verdictBands[index].maxScore}`;
}

export default function HowItWorks() {
  return (
    <article className="space-y-10">
      <header className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">How the score is built</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
          The abuse being detected is mass account creation, so the question is not whether a domain is
          malicious but whether it can mint unlimited mailboxes cheaply, and whether it was created to do
          so. Every credit below is paid on evidence somebody other than the domain had to supply, which
          is the thing an account farmer cannot mint at scale. Records a domain publishes about itself
          are still read and still shown, because they are facts a reader wants, but they score nothing
          in either direction.
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
          This page is generated from the live scoring configuration, model version{' '}
          <span className="font-mono">{DEFAULT_CONFIG.modelVersion}</span>, so it cannot drift from what
          the scorer actually does. The same content is available from{' '}
          <span className="font-mono">/api/model</span>.
        </p>
      </header>

      <section className="space-y-3">
        <h3 className="text-base font-semibold">Two outputs, never one number</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
          Legitimacy is additive evidence from a neutral {DEFAULT_CONFIG.neutralBase}. Confidence is the
          weighted coverage of the sources that actually answered. The second number exists because
          absence of evidence is not evidence of abuse: a legitimate new small business and a fresh farm
          domain look alike, so below a confidence of{' '}
          {DEFAULT_CONFIG.confidence.insufficientThreshold} the verdict is withheld entirely rather than
          guessed. The governing rule throughout is that a penalty requires positive evidence of a
          problem.
        </p>
        <ul className="space-y-2 text-sm">
          {(Object.keys(VERDICT_LABELS) as Verdict[]).map((verdict) => (
            <li
              key={verdict}
              className="grid gap-1 sm:grid-cols-[11rem_14rem_minmax(0,1fr)] sm:gap-4"
            >
              <span className="font-medium">{VERDICT_LABELS[verdict]}</span>
              <span className="font-mono text-xs text-ink-faint">
                {verdictRange(verdict)}
              </span>
              <span className="text-ink-muted">{VERDICT_DESCRIPTIONS[verdict]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold">Dimensions and their limits</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
          Every dimension is clamped, so no single one can carry a verdict alone. The primary dimension
          has the widest negative range because a throwaway-inbox fingerprint genuinely is close to
          conclusive, while organisational footprint is positive-only: having none of those records is the
          normal condition of a small business rather than evidence of anything.
        </p>
        <ul className="divide-y divide-edge text-sm">
          {dimensions.map((dimension) => (
            <li key={dimension} className="flex items-baseline gap-4 py-2">
              <span className="w-52 shrink-0">{DIMENSION_LABELS[dimension] ?? dimension}</span>
              <span className="font-mono text-xs text-ink-muted">
                {signed(DEFAULT_CONFIG.clamps[dimension].min)} to{' '}
                {signed(DEFAULT_CONFIG.clamps[dimension].max)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4">
        <h3 className="text-base font-semibold">Every heuristic, and why it exists</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
          Each heuristic carries the points it can move the score by, and both the heuristics and the
          dimensions are ordered with the heaviest first. A range means the heuristic is tiered, so what
          it pays depends on how much of the thing it found. These are the points before the clamp above,
          which is why a dimension&rsquo;s heuristics can add up past its limit and be cut back to it.
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
          The ones marked <span className="font-mono text-xs">reported, never scored</span> were
          measured and then deliberately moved nothing. Most are records the domain publishes about
          itself, which nothing can confirm and anyone can write, so they are shown as facts worth
          seeing rather than paid for. The rest are observations whose two explanations point in
          opposite directions, such as a suffix the reference price list does not carry, where saying so
          is better than guessing either way. All of them are listed rather than hidden, because a
          heuristic that pays nothing on purpose should be visibly distinct from one that never ran.
        </p>
        {heuristics.map((group) => (
          <div key={group.dimension} className="space-y-2">
            <h4 className="text-sm font-medium text-ink-muted">
              {DIMENSION_LABELS[group.dimension] ?? group.dimension}
            </h4>
            <ul className="space-y-3 rounded-lg border border-edge bg-surface-raised p-4">
              {group.signals.map(({ signal, weight }) => (
                <li key={signal.id}>
                  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm font-medium">
                    <span>{signal.label}</span>
                    <span className="font-mono text-xs font-normal text-ink-faint">
                      {describeWeight(weight)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">{signal.rationale}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold">Combinations</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
          A purely additive model errs in both directions: it misses conjunctions where each part has an
          innocent explanation that only the combination eliminates, and it double-counts correlated
          signals, which is how a legitimate small business accumulates penalties for being
          unsophisticated. Evaluation order is fixed at signals, discounts, bonuses, overrides, clamps,
          then bands, and the total from all combinations is capped at{' '}
          {DEFAULT_CONFIG.combinations.totalCap} points.
        </p>
        <ul className="space-y-3 rounded-lg border border-edge bg-surface-raised p-4">
          {COMBINATIONS.map((combination) => (
            <li key={combination.id}>
              <p className="text-sm font-medium">
                {combination.label}
                <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                  {combination.mode}
                </span>
              </p>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">
                {combination.rationale}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold">What this deliberately does not do</h3>
        <ul className="max-w-3xl space-y-2 text-sm leading-relaxed text-ink-muted">
          <li>
            <span className="font-medium text-ink">No reputation lookups. </span>
            Every signal comes from the domain&rsquo;s own configuration, pricing and content, so the model
            generalises to a domain registered minutes ago that no feed has seen. The cost is that it can
            never report a domain as known bad, only as structurally risky.
          </li>
          <li>
            <span className="font-medium text-ink">No deliverability checks. </span>
            An account farmer must receive the verification message, so working mail is a precondition of
            the abuse rather than evidence of it. A domain that cannot receive mail fails at verification
            anyway.
          </li>
          <li>
            <span className="font-medium text-ink">Nothing about the local part. </span>
            A teacher registering a class, a family, or a team creating sequential accounts all produce
            exactly the patterns those heuristics key on, so the false-positive cost lands on ordinary
            people rather than on abusers.
          </li>
          <li>
            <span className="font-medium text-ink">No brand-impersonation scoring. </span>
            Lookalike names are a phishing concern, not an account-farming one.
          </li>
          <li>
            <span className="font-medium text-ink">No hosting reputation. </span>
            A farm domain often has no website at all, and shared reseller hosting in a recently allocated
            prefix is how a great many legitimate small businesses are hosted.
          </li>
        </ul>
      </section>
    </article>
  );
}
