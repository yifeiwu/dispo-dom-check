'use client';

/**
 * Examples chosen to span the model rather than to flatter it: an established business, a disposable
 * mailbox service and an alias forwarder. The empty state is the only chance to show that the tool
 * discriminates, and a reader who has seen the range trusts a single verdict far more.
 */
const EXAMPLES = [
  { domain: 'github.com', hint: 'established' },
  { domain: 'mailinator.com', hint: 'disposable' },
  { domain: 'simplelogin.io', hint: 'forwarder' },
];

export function Examples({ onPick }: { onPick: (domain: string) => void }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-ink-muted">Or try one of these</h2>
      <ul className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <li key={example.domain}>
            <button
              type="button"
              onClick={() => onPick(example.domain)}
              className="flex items-baseline gap-2 rounded-full border border-edge-strong bg-surface-raised px-3 py-1.5 text-sm transition-colors hover:border-accent/40"
            >
              <span className="font-mono">{example.domain}</span>
              <span className="text-xs text-ink-faint">{example.hint}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="max-w-2xl text-sm leading-relaxed text-ink-faint">
        All three are real, functioning businesses. The model is not asking whether a domain is
        malicious, but whether it can mint unlimited deliverable addresses cheaply, so the interesting
        part is which dimension each one loses points on.
      </p>
    </section>
  );
}
