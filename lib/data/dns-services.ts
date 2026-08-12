/*
 * There is deliberately no custom-domain website-platform table here any more.
 *
 * It classified apex and `www` CNAME destinations into paid platforms and generic hosting, and
 * `configuration.hosted_service` was its only reader. That credit was removed in 1.2.0 after reaching 11
 * families across the whole holdout and firing on more legitimate domains than abuse ones, so the table,
 * the classifier, the `hostedServices` fact and the apex CNAME lookup that fed them all went with it.
 * Deleting the query rather than the signal alone is the point: a fingerprint table nobody reads still
 * has to be maintained against platforms that change their targets, and it was still costing a DNS round
 * trip per analysis. Known parking destinations are classified separately, in
 * `lib/data/redirect-targets.ts`, and that path is still read.
 */

const DKIM_PROVIDER_PATTERNS: readonly { pattern: string; provider: string }[] = [
  { pattern: 'onmicrosoft.com', provider: 'Microsoft 365' },
  { pattern: 'google.com', provider: 'Google Workspace' },
  { pattern: 'amazonses.com', provider: 'Amazon SES' },
  { pattern: 'sendgrid.net', provider: 'Twilio SendGrid' },
  { pattern: 'mandrillapp.com', provider: 'Mailchimp Transactional' },
  { pattern: 'mcdlv.net', provider: 'Mailchimp' },
  { pattern: 'hubspotemail.net', provider: 'HubSpot' },
  { pattern: 'klaviyosending.com', provider: 'Klaviyo' },
  { pattern: 'zendesk.com', provider: 'Zendesk' },
];

/*
 * There is deliberately no business-service table here any more either, and this one is worth reading as
 * the same mistake twice.
 *
 * Six well-known names were probed on every analysis — `autodiscover`, `enterpriseenrollment`,
 * `enterpriseregistration` and the `_sip._tls`, `_sipfederationtls._tcp` and `_caldav._tcp` SRV records —
 * and their destinations were classified into vendors to feed `footprint.business_services`. The credit
 * was withdrawn in 1.3.0 for the reason the whole dimension was: a CNAME or SRV record pointing at a
 * vendor requires no account with that vendor, and the calendaring and SIP names were credited for
 * pointing anywhere at all.
 *
 * The table also demonstrated its own fragility on the way out. `enterpriseregistration.windows.net` is
 * what that probe actually returns, and it appeared in 36 of the 4,760 stored transcripts while matching
 * no pattern here, so a quarter of the DNS work in `collectDns` was buying answers the classifier then
 * discarded. Adding the missing suffix was the obvious repair and would have been the wrong one: the
 * signal it fed could no longer move a verdict either way.
 */

function normaliseTarget(target: string): string {
  return target.trim().replace(/\.$/, '').toLowerCase();
}

function suffixMatches(target: string, pattern: string): boolean {
  return target === pattern || target.endsWith(`.${pattern}`);
}

export function classifyDkimProvider(target: string): string | undefined {
  const normalised = normaliseTarget(target);
  return DKIM_PROVIDER_PATTERNS.find(({ pattern }) => suffixMatches(normalised, pattern))?.provider;
}
