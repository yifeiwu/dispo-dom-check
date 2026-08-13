import { COMBINATIONS } from '@/lib/scoring/combinations';
import { OBSERVATIONS } from '@/lib/scoring/observations';
import { SIGNALS, type WeightRange } from '@/lib/scoring/signals';
import { VERDICT_DESCRIPTIONS, VERDICT_LABELS } from '@/lib/scoring/verdict';
import { DEFAULT_CONFIG } from '@/lib/scoring/weights';
import { DIMENSION_LABELS } from '@/lib/api-types';
import { signedPoints as signed } from '@/lib/format';
import type { Verdict } from '@/lib/scoring/weights';
import type { ReactNode } from 'react';

/**
 * Rendered from the same objects the scorer evaluates, which is the entire point.
 *
 * Documentation written by hand drifts away from the model within a release or two. Because this page
 * reads the signal registry and the config directly, adding a signal without a rationale or changing a
 * weight is immediately visible here, and `GET /api/model` serves the same content for anyone who wants
 * it as data.
 */
export const dynamic = 'force-static';

/**
 * The page's own sections, in document order.
 *
 * Held as one list because the contents and the headings are otherwise two lists that have to be kept
 * agreeing by hand, and this page exists precisely to demonstrate that nothing on it is maintained that
 * way. Renaming a section renames its entry in the contents.
 */
const SECTIONS = [
  { id: 'outputs', title: 'Two outputs, never one number' },
  { id: 'dimensions', title: 'Dimensions and their limits' },
  { id: 'heuristics', title: 'Every heuristic, and why it exists' },
  { id: 'observations', title: 'Collected, reported, never scored' },
  { id: 'combinations', title: 'Combinations' },
  { id: 'exclusions', title: 'What this deliberately does not do' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

const TITLE = Object.fromEntries(SECTIONS.map((section) => [section.id, section.title])) as Record<
  SectionId,
  string
>;

function Section({
  id,
  className = 'space-y-3',
  children,
}: {
  id: SectionId;
  className?: string;
  children: ReactNode;
}) {
  return (
    // `scroll-mt` so a heading jumped to from the contents does not land flush against the viewport
    // edge with its first paragraph already half read.
    <section id={id} className={`scroll-mt-6 ${className}`}>
      <h3 className="text-base font-semibold">{TITLE[id]}</h3>
      {children}
    </section>
  );
}

const dimensions = Object.keys(DEFAULT_CONFIG.clamps) as (keyof typeof DEFAULT_CONFIG.clamps)[];

/** What the heuristic is worth at its strongest, which is what the list is ordered on. */
const magnitude = (weight: WeightRange): number =>
  Math.max(Math.abs(weight.min), Math.abs(weight.max));

/**
 * What a heuristic is worth.
 *
 * A heuristic held at zero is a third thing, distinct both from one that moves the score and from an
 * observation. An observation has no weight to set; these have one, and it was deliberately set to
 * nothing because the holdout was too thin to price them — `+0` on its own would read as an oversight
 * or a rounding, so it is spelled out instead. They are still listed here rather than hidden, because
 * their rationale is the argument for collecting the fact at all, and a reader deciding whether to
 * trust the model should be able to see what it declines to charge for.
 */
function describeWeight(weight: WeightRange): string {
  if (weight.min === 0 && weight.max === 0) {
    return weight.note ? `no points · ${weight.note}` : 'no points · reported, deliberately not priced';
  }
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
        <p className="max-w-3xl text-base leading-relaxed text-ink-muted">
          The abuse being detected is mass account creation, so the question is not whether a domain is
          malicious but whether it can mint unlimited mailboxes cheaply, and whether it was created to do
          so. Every credit below is paid on evidence somebody other than the domain had to supply, which
          is the thing an account farmer cannot mint at scale. Records a domain publishes about itself
          are still read and still shown, because they are facts a reader wants, but they score nothing
          in either direction.
        </p>
        <p className="max-w-3xl text-base leading-relaxed text-ink-muted">
          This page is generated from the live scoring configuration, model version{' '}
          <span className="font-mono">{DEFAULT_CONFIG.modelVersion}</span>, so it cannot drift from what
          the scorer actually does. The same content is available from{' '}
          <span className="font-mono">/api/model</span>.
        </p>
      </header>

      {/* The registry below runs to every heuristic in the model, which is long by design and unusable
          without a way in. */}
      <nav aria-label="On this page" className="rounded-lg border border-edge bg-surface-raised p-4">
        <h3 className="text-xs uppercase tracking-wide text-ink-faint">On this page</h3>
        <ul className="mt-2 space-y-1.5 text-sm">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-ink-muted underline decoration-dotted underline-offset-4 transition-colors hover:text-ink"
              >
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="outputs">
        <p className="max-w-3xl text-base leading-relaxed text-ink-muted">
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
      </Section>

      <Section id="dimensions">
        <p className="max-w-3xl text-base leading-relaxed text-ink-muted">
          Every dimension is clamped, so no single one can carry a verdict alone. Signup capability has
          the widest negative range because a throwaway-inbox fingerprint genuinely is close to
          conclusive, while registration economics is negative-only: a cheap suffix is worth noting and
          an expensive one buys nothing, since anyone willing to spend can.
        </p>
        <ul className="divide-y divide-edge text-sm">
          {dimensions.map((dimension) => (
            // The same responsive grid as the verdict list above, rather than the fixed 13rem label
            // column this used to carry, which left no room for the range on a narrow phone.
            <li key={dimension} className="grid gap-1 py-2 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4">
              <span>{DIMENSION_LABELS[dimension] ?? dimension}</span>
              <span className="font-mono text-xs text-ink-muted">
                {signed(DEFAULT_CONFIG.clamps[dimension].min)} to{' '}
                {signed(DEFAULT_CONFIG.clamps[dimension].max)}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="heuristics" className="space-y-4">
        <p className="max-w-3xl text-base leading-relaxed text-ink-muted">
          Each heuristic carries the points it can move the score by, and both the heuristics and the
          dimensions are ordered with the heaviest first. A range means the heuristic is tiered, so what
          it pays depends on how much of the thing it found. These are the points before the clamp above,
          which is why a dimension&rsquo;s heuristics can add up past its limit and be cut back to it.
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
      </Section>

      <Section id="observations">
        <p className="max-w-3xl text-base leading-relaxed text-ink-muted">
          These are not heuristics with a weight of zero. They carry no weight at all, and there is no
          number to set: an observation can only report what was seen. Three different findings land a
          fact here. Most are records the domain publishes about itself, which nothing can confirm and
          anyone can write, so paying for them would price what an operator was willing to type. Some
          are facts whose two explanations point in opposite directions, such as a suffix the reference
          price list does not carry, where saying so is better than guessing either way. And one, a
          validated DNSSEC chain, is corroborated perfectly well and stopped scoring for the opposite
          reason: it was measured against the holdout and found to describe which registrar was used
          rather than who was using it. They are shown beside every verdict because a reader can weigh
          what the score will not, and their absence is never a penalty.
        </p>
        <ul className="space-y-3 rounded-lg border border-edge bg-surface-raised p-4">
          {OBSERVATIONS.map((observation) => (
            <li key={observation.id}>
              <p className="text-sm font-medium">{observation.label}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">
                {observation.rationale}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="combinations">
        <p className="max-w-3xl text-base leading-relaxed text-ink-muted">
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
                <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-xs uppercase tracking-wide text-ink-faint">
                  {combination.mode}
                </span>
              </p>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">
                {combination.rationale}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="exclusions">
        <ul className="max-w-3xl space-y-2 text-base leading-relaxed text-ink-muted">
          <li>
            <span className="font-medium text-ink">Nothing is scored on a third party&rsquo;s opinion. </span>
            No blocklist is consulted and no feed is asked whether a domain is bad, so the model
            generalises to a domain registered minutes ago that nobody has seen. The cost is that it can
            never report a domain as known bad, only as structurally risky. What a third party had to{' '}
            <em>agree</em> to is the opposite case, and the evidence the model most prefers: a mail vendor
            publishing the record that authorises this domain to report to it, or a certificate authority
            issuing a mark certificate against a registered trademark. Those are facts somebody else
            established, not judgements somebody else made, and each is checked rather than taken on
            trust.
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
            prefix is how a great many legitimate small businesses are hosted. Noticing that a named
            website platform is serving a domain from its own address space is a different claim, and an
            allowed one: it says a platform routes this name, which platforms do for paying accounts. The
            claim being avoided is that an address range is disreputable.
          </li>
        </ul>
      </Section>
    </article>
  );
}
