import { describe, expect, it } from 'vitest';
import { score } from '@/lib/scoring/score';
import { VERDICT_LABELS } from '@/lib/scoring/verdict';
import { establishedSmallBusiness, nothingObserved, providerSubdomain } from './fixtures';

/**
 * The narrative is the only part of a result written as prose, so it is the only part where a gap in a
 * lookup table becomes a sentence rather than a blank. Both defects pinned here shipped: the source
 * phrasebook was missing `whois` and printed the raw identifier, and the two registration protocols
 * were described separately even though the collectors treat them as one record.
 *
 * The phrasebook is now keyed on `SourceId`, so a missing entry is a type error and needs no test.
 * What the compiler cannot check is the wording that comes out, which is what these assert.
 */
describe('narrative', () => {
  const cases = {
    'an established business': establishedSmallBusiness(),
    'a platform-issued name': providerSubdomain(),
    'a domain nothing answered for': nothingObserved(),
  };

  /** Neither is an English word, so either appearing at all means a phrase lookup fell through. */
  it.each(Object.entries(cases))('names no protocol by its identifier for %s', (_name, facts) => {
    expect(score(facts).narrative).not.toMatch(/\b(rdap|whois)\b/i);
  });

  /**
   * WHOIS is skipped on every suffix that publishes RDAP, which is most of them, so a domain whose
   * registration was read perfectly well is the common case rather than an edge one.
   */
  it('says nothing about registration when one of the two protocols answered', () => {
    expect(score(establishedSmallBusiness()).narrative).not.toContain('registration record');
  });

  it('reports registration as inapplicable only when neither protocol applied', () => {
    expect(score(providerSubdomain()).narrative).toContain(
      'The registration record and suffix pricing do not apply',
    );
  });

  /**
   * A source cannot be both, and the pairing used to produce exactly that: an unreachable RDAP server
   * reported the record as failed while the WHOIS it made unnecessary reported it as inapplicable.
   */
  it('does not report the registration record as failed and inapplicable at once', () => {
    const { narrative } = score(nothingObserved());
    expect(narrative).toContain('the registration record');
    expect(narrative).toContain('did not answer');
    expect(narrative).not.toMatch(/do(es)? not apply/);
  });

  /**
   * The gauge already shows the band and the number. Restating them as the first clause made every
   * narrative open with the same sentence the reader had just finished looking at.
   */
  it('starts with the drivers rather than restating the score', () => {
    const result = score(establishedSmallBusiness());
    expect(result.narrative).not.toContain('out of 100');
    expect(result.narrative).not.toMatch(new RegExp(`^${VERDICT_LABELS[result.verdict]}`));
  });
});
