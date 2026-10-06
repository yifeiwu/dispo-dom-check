import type { ScoringConfig, Verdict } from './weights';

/**
 * Band assignment, plus the two rules that overrule every band.
 *
 * Low confidence must not be allowed to produce a confident-looking verdict. A legitimate new small
 * business and a fresh farm domain look alike, so when coverage is thin the honest answer is that there
 * is not enough evidence, not a number in the middle of the range that a consumer might act on.
 *
 * `sharedMailProvider` outranks even that, because it is not a statement about how much was learned but
 * about whether the question applies. A domain whose mail is handled by a consumer provider's own
 * infrastructure is a mailbox shared by a very large number of unrelated people, and every number this
 * model produces describes one organisation's domain. Scoring it is as meaningless as scoring the
 * provider's main name, which `lib/domain.ts` has always declined to do — the difference is only that
 * the gate there reads a hardcoded list of provider domains before any network work, and a list of
 * those can never be complete, because the providers operate hundreds of vanity domains apiece.
 * `CONSUMER_MAIL_INFRASTRUCTURE_MX` is the generic form of the same test, and this is where its answer
 * finally lands.
 *
 * The score, the signals and the sources all survive it. Declining to give a verdict is not declining
 * to show the evidence, and a reader who disagrees that a domain is a shared provider needs to see what
 * was observed in order to say so.
 */
export function verdictFor(
  legitimacy: number,
  confidence: number,
  cfg: ScoringConfig,
  sharedMailProvider = false,
): Verdict {
  if (sharedMailProvider) return 'out_of_scope';
  if (confidence < cfg.confidence.insufficientThreshold) return 'insufficient_evidence';

  const band = cfg.verdictBands.find((entry) => legitimacy <= entry.maxScore);
  return band?.verdict ?? 'unclear';
}

/*
 * There was a `bandPosition` here, reporting where in its band a score landed and how far it sat from
 * the nearer edge, on the argument that 55 and 69 are both "Probably legitimate" and mean different
 * things. The gauge that rendered it was reduced to the score and the band name, and nothing has
 * called this since. It is in the history rather than here, because a scoring helper nothing scores
 * with is indistinguishable from one that is quietly wrong: no fixture pins it and no test would
 * notice if a band edge moved underneath it.
 *
 * The argument for it is still good. If the gauge regains a marginality indicator, restore it with a
 * test attached. `how-it-works` computes the same edges inline for its verdict table, which is the
 * one live reader of that arithmetic.
 */

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
