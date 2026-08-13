import type { AnalysisResult } from './analyze';
import type { AnalyzeResponse, OutOfScopeResponse } from './api-types';
import type { NormalisedInput } from './domain';
import { VERDICT_DESCRIPTIONS, VERDICT_LABELS } from './scoring/verdict';
import { DEFAULT_CONFIG } from './scoring/weights';

/**
 * The mapping from an internal `AnalysisResult` to the published response contract.
 *
 * It lives here rather than in the route because three callers need to agree on it: the plain JSON
 * branch, the streaming branch's terminal `result` event, and the tests that render the UI against a
 * fixture. While it was private to the route the tests kept their own copy, and the copy drifted —
 * pinning a model version two releases behind without anything failing.
 *
 * Held apart from `api-types.ts` deliberately. That module is imported by the client, and it is
 * types plus label tables precisely so that importing it pulls no scoring code into the browser
 * bundle; this one reaches into `analyze` and the weight table.
 */
export function toAnalyzeResponse(result: AnalysisResult): AnalyzeResponse {
  return {
    domain: result.domain,
    submittedHost: result.submittedHost,
    // Reported so the UI can state plainly that the local part was discarded and never stored.
    inputWasEmailAddress: result.fromEmailAddress,
    analysedAt: result.analysedAt,
    elapsedMs: result.elapsedMs,
    modelVersion: result.score.modelVersion,
    legitimacy: result.score.legitimacy,
    risk: result.score.risk,
    confidence: result.score.confidence,
    verdict: result.score.verdict,
    verdictLabel: VERDICT_LABELS[result.score.verdict],
    verdictDescription: VERDICT_DESCRIPTIONS[result.score.verdict],
    narrative: result.score.narrative,
    flags: result.score.flags,
    firstSeen: result.score.firstSeen,
    ageDays: result.score.ageDays,
    dimensions: result.score.dimensions,
    signals: result.score.signals,
    inapplicableSignals: result.score.inapplicableSignals,
    observations: result.score.observations,
    combinations: result.score.combinations,
    sources: result.facts.sources,
    providerSuffix: result.facts.meta.providerSuffix,
  };
}

/**
 * The reply for an input that resolved to a domain the model declines to score. Built here for the
 * same reason as the success payload: it carries the model version, and a hand-written copy of it is
 * exactly what fell behind before.
 */
export function toOutOfScopeResponse(
  input: Extract<NormalisedInput, { kind: 'out_of_scope' }>,
): OutOfScopeResponse {
  return {
    domain: input.domain,
    outOfScope: { reason: input.reason, explanation: input.explanation },
    verdict: 'out_of_scope',
    verdictLabel: VERDICT_LABELS.out_of_scope,
    verdictDescription: VERDICT_DESCRIPTIONS.out_of_scope,
    modelVersion: DEFAULT_CONFIG.modelVersion,
  };
}
