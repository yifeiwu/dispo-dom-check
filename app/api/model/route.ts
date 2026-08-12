import { NextResponse } from 'next/server';
import { COMBINATIONS } from '@/lib/scoring/combinations';
import { SIGNALS } from '@/lib/scoring/signals';
import { VERDICT_DESCRIPTIONS, VERDICT_LABELS } from '@/lib/scoring/verdict';
import { DEFAULT_CONFIG } from '@/lib/scoring/weights';

/**
 * The active model, served from the same objects the scorer evaluates.
 *
 * The how-it-works page renders from this endpoint rather than from prose, which is the only way to stop
 * user-facing documentation drifting away from the scoring. If a weight changes, the page changes with
 * it, and if a signal is added without a rationale it is visible immediately.
 */
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      modelVersion: DEFAULT_CONFIG.modelVersion,
      config: DEFAULT_CONFIG,
      signals: SIGNALS.map((signal) => ({
        id: signal.id,
        dimension: signal.dimension,
        label: signal.label,
        rationale: signal.rationale,
        /** The points the heuristic can contribute, before its dimension clamp. */
        weight: signal.weight(DEFAULT_CONFIG),
      })),
      combinations: COMBINATIONS.map((combination) => ({
        id: combination.id,
        mode: combination.mode,
        label: combination.label,
        rationale: combination.rationale,
        requires: combination.requires,
      })),
      verdicts: Object.entries(VERDICT_LABELS).map(([verdict, label]) => ({
        verdict,
        label,
        description: VERDICT_DESCRIPTIONS[verdict as keyof typeof VERDICT_DESCRIPTIONS],
      })),
      evaluationOrder: [
        'signals',
        'discounts',
        'bonuses',
        'overrides',
        'per-dimension clamps',
        'verdict bands',
      ],
      limitation:
        'Every signal derives from the domain\'s own configuration, pricing and content. There are no third-party reputation lookups, so this tool can report that a domain is structurally risky but never that it is known bad. Combine it with your own blocklist rather than replacing one.',
    },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
