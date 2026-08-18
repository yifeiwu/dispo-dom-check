'use client';

import type { Failure } from '@/hooks/useAnalysis';

/**
 * Red for a request that never arrived, amber for one the service turned down. The distinction is
 * worth a colour because only the first is plausibly the reader's to fix.
 */
const FAILURE_TONE = {
  network: {
    box: 'border-danger/30 bg-danger/5 text-danger',
    button: 'border-danger/40 hover:bg-danger/10',
  },
  service: {
    box: 'border-warn/30 bg-warn/5 text-warn',
    button: 'border-warn/40 hover:bg-warn/10',
  },
  input: {
    box: 'border-warn/30 bg-warn/5 text-warn',
    button: 'border-warn/40 hover:bg-warn/10',
  },
} as const;

type Props = {
  failure: Failure;
  /** The domain a retry would re-run. Absent when there is nothing to retry. */
  retryable: string | null;
  pending: boolean;
  onRetry: (domain: string) => void;
};

export function FailureNotice({ failure, retryable, pending, onRetry }: Props) {
  const tone = FAILURE_TONE[failure.kind];

  return (
    <div
      role="alert"
      className={`flex flex-wrap items-baseline justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${tone.box}`}
    >
      <p className="min-w-0">{failure.message}</p>
      {/* Nothing to retry when the input never left the browser: the same text would be rejected
          the same way, so the only useful move is editing it. */}
      {retryable && failure.kind !== 'input' ? (
        <button
          type="button"
          onClick={() => onRetry(retryable)}
          disabled={pending}
          className={`shrink-0 rounded-md border px-2.5 py-1 font-medium transition-colors disabled:opacity-50 ${tone.button}`}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
