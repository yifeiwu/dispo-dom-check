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
  { provider: 'Throwaway Mail', patterns: ['throwawaymail.com'] },
  { provider: 'Tempr', patterns: ['tempr.email', 'discard.email'] },
  { provider: 'Mailcatch', patterns: ['mailcatch.com'] },
  { provider: 'Harakiri Mail', patterns: ['harakirimail.com'] },
  { provider: 'Linshi Youxiang', patterns: ['linshiyouxiang.net'] },
  { provider: 'Chacuo', patterns: ['chacuo.net'] },
  { provider: 'Luxusmail', patterns: ['luxusmail.org'] },
  { provider: 'Internxt Temporary Email', patterns: ['internxt.com'] },
  { provider: 'Burner Mail', patterns: ['burnermail.io'] },
];
