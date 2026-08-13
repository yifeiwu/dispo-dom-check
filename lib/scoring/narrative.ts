import type { SourceId } from '../collector';
import type { DomainFacts, SourceStatus } from '../facts';
import type { ScoreResult } from './score';
import { VERDICT_LABELS } from './verdict';

/**
 * The plain-language summary, generated from the strongest contributors rather than written by hand.
 *
 * Generating it means it cannot drift from the score, and it gives a reader who will not expand the
 * signal table the one or two facts that actually drove the verdict, plus an honest statement of what
 * was missing.
 */
export function narrate(result: ScoreResult, facts: DomainFacts): string {
  const sentences: string[] = [];

  if (facts.meta.providerSuffix) {
    sentences.push(
      `This name was issued by ${facts.meta.providerSuffix.provider}, so the verdict covers this subdomain only: its registration age and price belong to the provider.`,
    );
  }

  const drivers = [...result.signals]
    .filter((signal) => signal.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 3);

  const negatives = drivers.filter((signal) => signal.points < 0);
  const positives = drivers.filter((signal) => signal.points > 0);

  const headline = VERDICT_LABELS[result.verdict];

  if (result.verdict === 'insufficient_evidence') {
    sentences.push(
      `${headline}: not enough sources answered to reach a verdict, so no score is being asserted.`,
    );
  } else if (negatives.length > 0 && positives.length > 0) {
    sentences.push(
      `${headline}, at ${result.legitimacy} out of 100. ${cap(joinPhrases(negatives.map(phrase)))}, though ${joinPhrases(positives.map(phrase))}.`,
    );
  } else if (negatives.length > 0) {
    sentences.push(`${headline}, at ${result.legitimacy} out of 100. ${cap(joinPhrases(negatives.map(phrase)))}.`);
  } else if (positives.length > 0) {
    sentences.push(`${headline}, at ${result.legitimacy} out of 100. ${cap(joinPhrases(positives.map(phrase)))}.`);
  } else {
    sentences.push(
      `${headline}, at ${result.legitimacy} out of 100. Nothing notable fired in either direction.`,
    );
  }

  // Conjunctions deserve their own sentence, because a combination driving the verdict is exactly the
  // thing a purely additive reading of the table would miss.
  const decisiveCombo = result.combinations
    .filter((combo) => combo.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))[0];
  if (decisiveCombo) {
    sentences.push(`${decisiveCombo.label} was treated as more than the sum of its parts.`);
  }
  const override = result.combinations.find((combo) => combo.mode === 'override');
  if (override) {
    sentences.push(`${override.label} applied, which overrode the additive score.`);
  }

  /*
   * A source that failed and a source that was deliberately not consulted are different things, and
   * describing a skipped source as unavailable would misrepresent why it is absent.
   *
   * The reputation lookup is left out of both sentences below. It carries no confidence weight, so
   * naming it in a sentence that ends "so confidence is N rather than higher" would state something
   * untrue: an exhausted monthly allowance moves the confidence figure by exactly nothing. Its status
   * and its reason are still rendered in the source panel, which is where a reader looks to find out
   * whether it answered.
   */
  const reportable = logicalSources(facts.sources).filter(
    (source) => source.source !== 'checkmail',
  );
  const failed = reportable.filter(
    (source) => source.status === 'timeout' || source.status === 'rate_limited' || source.status === 'unavailable',
  );
  const inapplicable = reportable.filter(
    (source) => source.status === 'unsupported' || source.status === 'skipped',
  );

  if (failed.length > 0) {
    sentences.push(
      `${cap(joinPhrases(listSources(failed)))} did not answer, so confidence is ${result.confidence} rather than higher.`,
    );
  }
  if (inapplicable.length > 0) {
    const named = listSources(inapplicable);
    sentences.push(
      `${cap(joinPhrases(named))} ${named.length === 1 ? 'does' : 'do'} not apply to this domain, which is accounted for rather than penalised.`,
    );
  }

  return sentences.join(' ');
}

/**
 * How each source is named inside a sentence.
 *
 * A separate map from `SOURCE_LABELS` in `lib/api-types.ts` on purpose: that one supplies headings for
 * the source panel, and a heading and a mid-sentence phrase are different registers. What they must
 * share is completeness, which is why this is keyed on `SourceId` rather than on `string`. Left loose,
 * it silently lost `whois`: the port-43 collector is skipped on every suffix that publishes RDAP, so
 * almost every narrative ended by reporting that "Whois" did not apply.
 */
const SOURCE_PHRASES: Record<SourceId, string> = {
  rdap: 'the registration record',
  whois: 'the registration record',
  dns: 'DNS',
  mail: 'mail configuration',
  signup: 'mail-provider classification',
  pricing: 'suffix pricing',
  site: 'the site probe',
  checkmail: 'the reputation lookup',
};

function phrase(signal: { label: string; evidence: string }): string {
  return signal.evidence.charAt(0).toLowerCase() + signal.evidence.slice(1);
}

function joinPhrases(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const isRegistration = (source: SourceStatus): boolean =>
  source.source === 'rdap' || source.source === 'whois';

/**
 * Collapses the two registration protocols into the one logical source a reader thinks in.
 *
 * RDAP and WHOIS are two transports for the same record, and the collectors pick between them by
 * suffix, so the one that was not needed is always reported as skipped. Describing that to a reader
 * verbatim produces both halves of a contradiction: a `.com` whose RDAP answered still carries a
 * skipped WHOIS, and telling someone the registration record does not apply to a domain whose
 * registration record was just read is worse than saying nothing at all.
 *
 * If either transport answered, the record is covered and neither half is worth a sentence. If neither
 * did, the pair keeps whichever one was actually attempted, so a registry that was unreachable reads
 * as a failure while a platform-issued name, where both are skipped because registration genuinely
 * belongs to the provider, reads as inapplicable.
 */
function logicalSources(sources: SourceStatus[]): SourceStatus[] {
  const registration = sources.filter(isRegistration);
  if (registration.length === 0) return sources;
  if (registration.some((source) => source.status === 'ok')) {
    return sources.filter((source) => !isRegistration(source));
  }
  const attempted = registration.find((source) => source.status !== 'skipped') ?? registration[0];
  return sources.filter((source) => !isRegistration(source) || source === attempted);
}

/**
 * Deduplicated on the phrase rather than on the source id, because the two registration protocols
 * share one. Naming the registration record twice in the same sentence would read as though two
 * separate things were missing.
 */
function listSources(sources: SourceStatus[]): string[] {
  return [...new Set(sources.map((source) => SOURCE_PHRASES[source.source]))];
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
