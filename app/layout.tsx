import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dispo Dom Check',
  description:
    'Explainable signup-risk scoring for a domain, assembled from registration records, DNS and mail configuration, suffix pricing and a live site probe.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {/*
          Hidden until focused, which is the whole trick: it costs a sighted reader nothing and saves a
          keyboard one from tabbing the header on every analysis.
        */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-lg focus:border focus:border-edge-strong focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>

        <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-5 py-8 sm:px-8">
          <header className="flex items-baseline justify-between gap-4 border-b border-edge pb-5">
            <Link href="/" className="group">
              <h1 className="text-lg font-semibold tracking-tight">Dispo Dom Check</h1>
              <p className="text-sm text-ink-muted">
                Is this domain built to mint mailboxes, or to run a business?
              </p>
            </Link>
            <nav className="flex shrink-0 gap-4 text-sm">
              <Link
                href="/how-it-works"
                className="text-ink-muted underline decoration-dotted underline-offset-4 transition-colors hover:text-ink"
              >
                How it works
              </Link>
            </nav>
          </header>

          <main id="main" className="flex-1 py-8">
            {children}
          </main>

          <footer className="border-t border-edge pt-5 text-sm leading-relaxed text-ink-faint">
            This tells you a domain is structurally risky far better than it tells you a domain is
            known bad. Combine it with your own blocklist rather than replacing one.
          </footer>
        </div>
      </body>
    </html>
  );
}
