'use client';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
};

export function AnalysisForm({ value, onChange, onSubmit, pending }: Props) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        onSubmit();
      }}
      className="space-y-2"
    >
      <label htmlFor="domain" className="block text-sm font-medium">
        Domain or email address
      </label>
      <div className="flex gap-2">
        <input
          id="domain"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="a domain, or a full address"
          aria-describedby="domain-help"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-edge-strong bg-surface-sunken px-3 py-2.5 font-mono text-sm outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-accent/50"
        />
        <button
          type="submit"
          disabled={pending || !value.trim()}
          aria-busy={pending}
          // Dimmed enough to read as unavailable, not so far that the label stops meeting contrast.
          // At 40% this was the least legible text on the page, and it is the one control that tells a
          // first-time reader what the page does.
          className="shrink-0 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-surface transition-opacity disabled:opacity-70"
        >
          {pending ? 'Analysing' : 'Analyse'}
        </button>
      </div>
      <p id="domain-help" className="text-sm text-ink-faint">
        If you paste an address, everything before the @ is removed.
      </p>
    </form>
  );
}
