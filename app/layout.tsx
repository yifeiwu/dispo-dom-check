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

          <main className="flex-1 py-8">{children}</main>

          <footer className="border-t border-edge pt-5 text-xs leading-relaxed text-ink-faint">
            Every signal comes from the domain&rsquo;s own registration, DNS, pricing and content. There are
            no third-party reputation lookups, so this can tell you a domain is structurally risky but
            never that it is known bad. Combine it with your own blocklist rather than replacing one.
          </footer>
        </div>
      </body>
    </html>
  );
}
