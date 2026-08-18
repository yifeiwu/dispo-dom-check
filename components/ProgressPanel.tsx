'use client';

import { useEffect, useState } from 'react';
import { SourceProgress } from '@/components/SourcePanel';
import type { SourceStatus } from '@/lib/facts';

export function ProgressPanel({
  settled,
  onCancel,
}: {
  settled: SourceStatus[];
  onCancel: () => void;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-edge bg-surface-raised p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-ink-muted">
          Sources that do not answer in time are reported rather than waited on.
        </p>
        <span className="flex shrink-0 items-baseline gap-3">
          <Elapsed />
          {/*
            An analysis can legitimately run for the better part of a minute, so a reader who
            mistyped needs a way out that is not waiting for a domain they no longer care about.
          */}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-edge-strong px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
          >
            Cancel
          </button>
        </span>
      </div>
      <SourceProgress settled={settled} />
    </section>
  );
}

/**
 * Seconds since the analysis started.
 *
 * Mounted only while one is running, so its own lifetime is the measurement and there is nothing to
 * reset between queries. It earns its place because the source list can legitimately sit still for
 * several seconds while a slow registry is queried, and without a clock a reader cannot tell a slow
 * analysis from a page that has stopped doing anything.
 */
function Elapsed() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(timer);
  }, []);

  return <span className="text-xs tabular-nums text-ink-faint">{seconds}s</span>;
}
