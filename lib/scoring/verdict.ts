import type { ScoringConfig, Verdict } from './weights';

/**
 * Band assignment, plus the one rule that overrules every band.
 *
 * Low confidence must not be allowed to produce a confident-looking verdict. A legitimate new small
 * business and a fresh farm domain look alike, so when coverage is thin the honest answer is that there
 * is not enough evidence, not a number in the middle of the range that a consumer might act on.
 */
export function verdictFor(legitimacy: number, confidence: number, cfg: ScoringConfig): Verdict {
  if (confidence < cfg.confidence.insufficientThreshold) return 'insufficient_evidence';

  const band = cfg.verdictBands.find((entry) => legitimacy <= entry.maxScore);
  return band?.verdict ?? 'unclear';
}

/** Where a score sits inside the band it landed in, and what is on the other side of the nearer edge. */
export type BandPosition = {
  min: number;
  max: number;
  /** Absent only where the band has no neighbour on either side, which no configured band has. */
  nearest?: { verdict: Verdict; distance: number; direction: 'below' | 'above' };
};

/**
 * The band boundaries either side of a score, and which edge it is closer to.
 *
 * A band is a range, and reporting only its name throws away where in that range the domain landed:
 * 55 and 69 are both "Probably legitimate" and mean quite different things, while a 40 is one point
 * from being called "Unclear" instead. Anyone deciding how much friction to put in front of a signup
 * is better served knowing the score is marginal than knowing which side of a boundary it fell.
 *
 * Withheld and out-of-scope verdicts have no band to be positioned in and return nothing rather than
 * an invented one.
 */
export function bandPosition(legitimacy: number, cfg: ScoringConfig): BandPosition | undefined {
  const index = cfg.verdictBands.findIndex((entry) => legitimacy <= entry.maxScore);
  if (index === -1) return undefined;

  const min = index === 0 ? 0 : cfg.verdictBands[index - 1].maxScore + 1;
  const max = cfg.verdictBands[index].maxScore;

  const below = index === 0 ? undefined : cfg.verdictBands[index - 1];
  const above = cfg.verdictBands[index + 1];

  const candidates = [
    below && { verdict: below.verdict, distance: legitimacy - min + 1, direction: 'below' as const },
    above && { verdict: above.verdict, distance: max - legitimacy + 1, direction: 'above' as const },
  ].filter((entry) => entry !== undefined);

  // Ties go to the lower edge, which is the direction a reader adding friction cares about.
  const nearest = candidates.sort((a, b) => a.distance - b.distance)[0];

  return { min, max, nearest };
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  high_risk: 'High risk',
  suspicious: 'Suspicious',
  unclear: 'Unclear',
  probably_legitimate: 'Probably legitimate',
  established: 'Established',
  insufficient_evidence: 'Insufficient evidence',
  out_of_scope: 'Out of scope',
};

export const VERDICT_DESCRIPTIONS: Record<Verdict, string> = {
  high_risk:
    'The configuration matches the account-farm profile closely enough to act on: cheap or free disposable addressing with little else invested in the domain.',
  suspicious:
    'Several structural risk signals fired without a strong counterweight. Worth additional friction at signup rather than an outright block.',
  unclear:
    'The evidence points both ways, or the domain is simply young and unremarkable. Treat this as a domain the tool cannot separate.',
  probably_legitimate:
    'The domain shows real investment and history, with no disposable-addressing signals.',
  established:
    'Long history, working mail and a genuine service surface. No plausible account farm looks like this.',
  insufficient_evidence:
    'Too few sources answered to score this domain. The verdict is withheld rather than guessed, and the source panel below shows what was missing.',
  out_of_scope:
    'This is a shared mail provider, so domain-level analysis says nothing about an individual account. Assess these at the account level using signup velocity and behaviour.',
};
