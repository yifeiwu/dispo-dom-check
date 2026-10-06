import type { SourceId } from './collector';
import type { SourceStatus } from './facts';

/**
 * Which of the two registration transports stands for the pair.
 *
 * RDAP and WHOIS are two ways of reading one record, and the orchestrator picks between them by
 * suffix, so whichever was not needed is always reported as skipped. Every reader that shows a source
 * to a human has to collapse that back into the one logical source a person thinks in, and three of
 * them did: the finished `Sources` panel, the progress view drawn while the analysis is still
 * running, and the narrative sentence about what failed to answer.
 *
 * They are here together because they must agree. The panel and the progress view already carry a
 * note that a source must not be described one way at three seconds and another way at eight, and the
 * narrative carries its own about never telling a reader the registration record does not apply to a
 * domain whose registration record was just read. Those are the same rule, and it was written out
 * three times in two layers with the predicate copied alongside it.
 *
 * What differs between the callers is what they do with the answer, not how they reach it, so only
 * the choosing lives here.
 */
export function isRegistrationSource(source: SourceId): boolean {
  return source === 'rdap' || source === 'whois';
}

/**
 * The transport that actually spoke, or `undefined` while that is not yet known.
 *
 * Preference order is an answer first, then an attempt, then RDAP. The `undefined` case is what the
 * progress view needs: during a stream only one of the pair may have settled, and drawing a second
 * row that is about to vanish is worse than drawing none.
 */
export function pickRegistration(
  rdap: SourceStatus | undefined,
  whois: SourceStatus | undefined,
): SourceStatus | undefined {
  if (rdap?.status === 'ok') return rdap;
  if (whois?.status === 'ok') return whois;
  if (rdap && whois) return rdap.status !== 'skipped' ? rdap : whois.status !== 'skipped' ? whois : rdap;
  return undefined;
}

/** The same choice, made over a finished list rather than over two known slots. */
export function registrationIn(sources: SourceStatus[]): SourceStatus | undefined {
  return pickRegistration(
    sources.find((source) => source.source === 'rdap'),
    sources.find((source) => source.source === 'whois'),
  );
}
