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
