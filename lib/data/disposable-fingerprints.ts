/**
 * Phrases by which a disposable-mail service names itself in its own page title.
 *
 * Every other disposable detector in this model identifies a *customer* of such a service: an exchanger
 * belonging to one, an exchanger resolving into one's address pool, an ownership token published for
 * one. A provider's own domain points its mail at its own infrastructure and publishes nothing for
 * anybody else, so it is invisible to all of them while looking exactly like the real business it is.
 * That is not a hypothetical gap. Of the 123 domains the holdout labels disposable and the 58 it labels
 * privacy, those three signals fire on *none*, and the provider domains among them score as high as 82
 * on age, record breadth and a working website — all of which they genuinely have.
 *
 * What they also have is a homepage advertising the product, which is the one thing a service selling
 * throwaway inboxes cannot hide: it has to be found by the people who want one. So this reads the title
 * of the page the site probe already fetched, which costs no request.
 *
 * It is a penalty, so the 1.3.0 rule confining credits to third-party confirmation does not reach it —
 * see the same note on `signup.disposable_token`. A domain that titles its homepage "Temp Mail" has
 * minted nothing; it has told us what it sells.
 *
 * ## The entry criterion, and why it is the title
 *
 * A phrase qualifies only if it names the *product* "a mailbox you throw away", such that putting it in
 * a title is a service describing itself rather than a page discussing the subject. The distinction is
 * the whole of the test, because the obvious way for this to misfire is on somebody writing *about*
 * disposable mail — an anti-abuse vendor, a validation API, a security blog — and those pages discuss
 * the topic in prose while titling themselves something else.
 *
 * Matching the title rather than the body is what buys that, and it was measured rather than assumed.
 * Across every stored page in the holdout, title matching hit 43 pages: 41 abuse, one disposable, one
 * privacy, and **no legitimate page at all**. Extending the same phrases to the body hit 116 pages and
 * tripled the number of abuse domains pulled out of a legitimate band, from 5 to 15 — and cost one
 * legitimate page, `silomails.com`, a SimpleLogin alias domain that describes the service it belongs to
 * in its own copy. Body matching is the better-looking trade and is deliberately not taken: this signal
 * saturates the signup floor and caps the verdict, which is too much to hang on a phrase that may be
 * commentary. The looser half is recorded in `docs/SCORING.md` rather than shipped.
 *
 * ## What was refused
 *
 * Three candidates measured clean on this holdout and were still left out, because a holdout of 212
 * legitimate domains cannot see the population they would eventually hit. `fake email` is what an email
 * *validation* vendor would title a page — the exact anti-abuse tool a consumer of this service might
 * also run — and it was worth only two pages. A bare `free temporary` would match a shop selling
 * temporary tattoos; the pages carrying it all match `disposable email` or `tempmail` anyway, so the
 * fragment bought nothing. `random email` and `instant email` never appeared in a title at all.
 *
 * Three further phrases hit legitimate pages directly and are excluded on measurement: `temporary
 * email` (83 abuse pages, but also `atomicmail.io` and `silomails.com`), `anonymous email`, and
 * `email alias` with its plural. The last is the clearest case of why the criterion is self-description
 * rather than topic: an alias forwarder is a legitimate privacy practice this model flags for the
 * consumer rather than condemns, and `mycloaked.id` and `passmail.net` are exactly who gets hurt.
 */
export const DISPOSABLE_TITLE_FINGERPRINTS: readonly string[] = [
  'disposable email',
  'disposable e-mail',
  'disposable mail',
  'disposable inbox',
  'temp mail',
  'tempmail',
  'temp-mail',
  'temporary inbox',
  'temporary mailbox',
  'throwaway email',
  'throwaway inbox',
  'burner email',
  'burner inbox',
  '10 minute mail',
  '10minutemail',
  'free temporary email',
  'free temporary mail',
  /*
   * A bare `temporary email` is excluded below for hitting legitimate pages, but these two are the
   * product's name rather than its subject, and that is exactly the line this table is drawn on. Both
   * are clean across every stored title; `silomails.com` carries `temporary email service` in its body
   * copy and not in its title, which is the whole reason only titles are matched.
   */
  'temporary email service',
  'temporary email addres',

  /*
   * The same product name in the languages the stored pages actually use, which is where this kind of
   * table otherwise goes blind. Two of these are load-bearing on the holdout: `email sementara` is how
   * the Indonesian services title themselves, and the `web.id` farms are the largest single family in
   * the collection. Spanish and Portuguese are matched on both the accented and unaccented spellings
   * because pages are inconsistent about encoding them.
   */
  'email sementara',
  'surat sementara',
  'correo temporal',
  'correos temporales',
  'email temporario',
  'email temporário',
  'email temporaire',
  'mail temporaire',
  'wegwerf',
  'einwegmail',
  'posta temporanea',
  'tijdelijke mail',
  'tymczasowy email',
  'geçici mail',
  'geçici e-posta',
  'временная почта',
  'одноразов',
  '临时邮箱',
  '临时邮件',
  '一時的なメール',
  '捨てメール',
  '임시 이메일',
];

/**
 * The phrase a page title uses to name itself a disposable-mail service, or `undefined`.
 *
 * Returns the matched phrase rather than a boolean so the evidence string can quote what was found. A
 * reader told their domain scored as a throwaway-inbox service is owed the words that decided it.
 */
export function matchDisposableTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const haystack = title.toLowerCase();
  return DISPOSABLE_TITLE_FINGERPRINTS.find((phrase) => haystack.includes(phrase));
}
