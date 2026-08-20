import type { MxFingerprint } from './mx-match';

/**
 * Temp-mail provider MX fingerprints. This table carries the primary scoring dimension on its own,
 * since third-party disposable-domain lists were deliberately excluded, so breadth matters more here
 * than anywhere else in the codebase.
 *
 * It is bundled code versioned with the model rather than a feed fetched per request. The advantage
 * over a list of disposable *domains* is generalisation: an operator spinning up a new throwaway name
 * every week keeps pointing it at the same mail exchangers, so the fingerprint catches names that no
 * list has seen yet.
 *
 * Entries are the publicly documented mail exchangers of well-known throwaway-inbox services. Extending
 * this table is ordinary maintenance work; a missing operator costs recall on the primary dimension.
 *
 * What belongs here is an inbox that expires. An alias that is permanent until its owner deletes it, and
 * that forwards to a mailbox the owner already had, is the alias arrangement `FORWARDER_MX` describes,
 * and this table is checked first and at more than three times the weight. Burner Mail was carried here
 * and has moved for that reason, having been listed as a relay domain the whole time.
 */
export const TEMP_MAIL_MX: readonly MxFingerprint[] = [
  { provider: 'Guerrilla Mail', patterns: ['guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'grr.la', 'sharklasers.com', 'spam4.me'] },
  { provider: 'YOPmail', patterns: ['yopmail.com', 'yopmail.net', 'yopmail.fr'] },
  { provider: 'Mailinator', patterns: ['mailinator.com', 'mailinator.net'] },
  { provider: 'Temp-Mail', patterns: ['temp-mail.org', 'temp-mail.io', 'tempmail.dev'] },
  { provider: 'Mail.tm / Mail.gw', patterns: ['mail.tm', 'mail.gw'] },
  { provider: 'DropMail', patterns: ['dropmail.me', 'dropmail.cc'] },
  { provider: 'Moakt', patterns: ['moakt.com', 'moakt.ws', 'moakt.co'] },
  { provider: 'TempMail Plus', patterns: ['tempmail.plus'] },
  { provider: '10MinuteMail', patterns: ['10minutemail.com', '10minutemail.net'] },
  { provider: 'Maildrop', patterns: ['maildrop.cc'] },
  { provider: 'Mailnesia', patterns: ['mailnesia.com'] },
  { provider: 'Trashmail', patterns: ['trashmail.com', 'trashmail.net', 'trashmail.de', 'trash-mail.com'] },
  { provider: 'Dispostable', patterns: ['dispostable.com'] },
  { provider: 'Fake Mail Generator', patterns: ['fakemailgenerator.com', 'fakemail.net'] },
  { provider: 'EmailOnDeck', patterns: ['emailondeck.com'] },
  { provider: 'Nada', patterns: ['getnada.com', 'nada.email'] },
  { provider: 'InboxKitten', patterns: ['inboxkitten.com'] },
  { provider: 'Mohmal', patterns: ['mohmal.com', 'mohmal.in'] },
  { provider: 'Email Fake', patterns: ['emailfake.com', 'email-fake.com'] },
  { provider: 'Etempmail', patterns: ['etempmail.com', 'etempmail.net'] },
  { provider: 'Minute Inbox', patterns: ['minuteinbox.com'] },
  { provider: 'Tempmailo', patterns: ['tempmailo.com'] },
  { provider: 'SmailPro', patterns: ['smailpro.com'] },
  { provider: 'Mailsac', patterns: ['mailsac.com'] },
  { provider: 'MailSlurp', patterns: ['mailslurp.com'] },
  {
    provider: 'TempMail.lol',
    patterns: ['tempmail.lol'],
    note: 'the service also sells custom domains that hide this hostname; those are reached by the endpoint and token tables',
  },
  { provider: 'Throwaway Mail', patterns: ['throwawaymail.com'] },
  { provider: 'Tempr', patterns: ['tempr.email', 'discard.email'] },
  { provider: 'Mailcatch', patterns: ['mailcatch.com'] },
  { provider: 'Harakiri Mail', patterns: ['harakirimail.com'] },
  { provider: 'Linshi Youxiang', patterns: ['linshiyouxiang.net'] },
  { provider: 'Chacuo', patterns: ['chacuo.net'] },
  { provider: 'Luxusmail', patterns: ['luxusmail.org'] },
  { provider: 'Internxt Temporary Email', patterns: ['internxt.com'] },
];

/**
 * The addresses those services take mail on, for the domains whose mail exchanger names only their own
 * zone.
 *
 * The table above can only ever see an operator who points a domain at a hostname the operator owns.
 * The custom-domain products these services sell do the opposite: the setup instructions tell the
 * customer to publish `mx.theirdomain.com` and give it an A record pointing at the provider. The mail
 * exchanger then names the customer's zone, matches nothing above, and the domain reads as an ordinary
 * self-hosted mail setup. `docs/CALIBRATION.md` records the consequence — the hostname fingerprint
 * matched none of the 123 rows labelled `DISPOSABLE` — and lengthening the hostname list cannot fix it,
 * because there is no provider hostname to match.
 *
 * What does not vary is the machine at the end. One server accepts the mail for every domain in the
 * pool, so the address is the part of the arrangement the operator cannot cheaply rotate.
 *
 * Two rules govern what may be added here, and both matter more than the length of the list:
 *
 * Entries come from a provider's own published setup instructions, never from the benchmark. Deriving
 * an address from the labelled holdout would make every figure the holdout then produced circular,
 * which `docs/CALIBRATION.md` says of this exact table in as many words.
 *
 * Entries name a mail endpoint, not a network. This is not the hosting reputation `docs/SOURCES.md`
 * rejects: no ASN is consulted, no prefix is judged, and a shared host at the same provider is not
 * implicated. An address that stops matching because the provider moved costs nothing, which is the
 * direction a fingerprint should fail in.
 */
export type MxEndpoint = {
  provider: string;
  /** Exact addresses, or prefixes written with a trailing dot, as in `203.0.113.`. */
  addresses: string[];
  note?: string;
};

export const TEMP_MAIL_MX_ENDPOINTS: readonly MxEndpoint[] = [
  {
    provider: 'TempMail.lol',
    addresses: ['46.62.148.222'],
    note: 'the address its custom-domain instructions tell users to publish as `mx`',
  },
];

/**
 * SPF includes those same services tell a custom-domain customer to publish.
 *
 * Read out of the apex TXT set the analysis already fetches, so this costs no query. It reaches the
 * operator who disguised the mail exchanger but still authorised the provider to send — which the
 * custom-domain setup that wants bounce handling almost always does.
 *
 * Same two rules as the endpoint table: provider documentation only, and an include that disappears
 * stops matching rather than implicating a neighbour.
 */
export const TEMP_MAIL_SPF_INCLUDES: readonly { include: string; provider: string }[] = [
  { include: 'relays.mailsac.com', provider: 'Mailsac' },
];

/**
 * Nameservers a throwaway-inbox service requires the customer to delegate to.
 *
 * Empty because no provider currently documents a required nameserver in its public custom-domain
 * setup: they ask for MX, an A record, and a TXT token, and the customer keeps their existing DNS.
 * The matcher is wired so an entry is one line when one appears; until then the lookup is skipped,
 * which is the same early-out the endpoint table uses when it has nothing to compare.
 */
export const TEMP_MAIL_NS: readonly { pattern: string; provider: string }[] = [];

export function matchTempMailSpf(
  spfRecord: string | undefined,
): { provider: string; include: string } | null {
  if (!spfRecord) return null;
  const haystack = spfRecord.toLowerCase();
  for (const { include, provider } of TEMP_MAIL_SPF_INCLUDES) {
    if (haystack.includes(`include:${include}`)) return { provider, include };
  }
  return null;
}

export function matchTempMailNs(nameservers: readonly string[] | undefined): string | null {
  if (!nameservers || TEMP_MAIL_NS.length === 0) return null;
  for (const host of nameservers) {
    const normalised = host.toLowerCase().replace(/\.$/, '');
    for (const { pattern, provider } of TEMP_MAIL_NS) {
      const needle = pattern.toLowerCase();
      if (normalised === needle || normalised.endsWith(`.${needle}`)) return provider;
    }
  }
  return null;
}

export function matchEndpoint(address: string): string | null {
  const normalised = address.trim();
  for (const endpoint of TEMP_MAIL_MX_ENDPOINTS) {
    for (const candidate of endpoint.addresses) {
      const matched = candidate.endsWith('.')
        ? normalised.startsWith(candidate)
        : normalised === candidate;
      if (matched) return endpoint.provider;
    }
  }
  return null;
}
