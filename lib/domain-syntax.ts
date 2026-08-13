/**
 * The part of input validation that needs no suffix list.
 *
 * Split out of `./domain` so the browser can run it. The checks here reject an input on its shape
 * alone — empty, overlong, unparseable, an address literal, a reserved name — and every one of them is
 * a rejection the endpoint would have returned after a round trip. Answering them in the browser costs
 * a typo nothing and, more usefully, does not spend one of the twenty requests a minute the endpoint
 * allows.
 *
 * The line is drawn exactly at the public suffix list. Deciding whether `.sbs` is a real suffix means
 * shipping the list, which measured at +44 kB on the landing page's first load: a 39% increase to catch
 * mistakes the server catches anyway. Those rejections stay server-side, and this module stays free of
 * `tldts` and of every data table in `./data`. Keep it that way — an import added here is an import
 * added to the first paint.
 *
 * Sharing the code rather than reimplementing a looser copy of it is the point. A second opinion about
 * what counts as a domain would drift from the first, and the browser's would be the one nobody tested.
 */

export type RejectionReason =
  | 'empty'
  | 'malformed'
  | 'ip_address'
  | 'localhost'
  | 'private_suffix'
  | 'unknown_suffix'
  | 'too_long';

export type SyntaxResult =
  | { kind: 'rejected'; reason: RejectionReason; explanation: string }
  /** The host, with any local part already discarded. */
  | { kind: 'ok'; host: string; fromEmailAddress: boolean };

export const MAX_INPUT_LENGTH = 253;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = new Set(['localhost', 'local', 'internal', 'test', 'example', 'invalid', 'onion']);

/**
 * An address literal rather than a name.
 *
 * Exported because the boundary is not the only place this question is asked: a redirect target is a
 * host chosen by the domain under analysis, and it has to face the same test the submitted host did.
 */
export function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.includes(':');
}

/** A reserved or special-use name, which has no public registration behind it. */
export function isReservedName(host: string): boolean {
  const lastLabel = host.split('.').pop() ?? '';
  return host === 'localhost' || LOCAL_SUFFIXES.has(lastLabel);
}

/**
 * Reduces an input to the host portion, discarding a local part if one is present.
 * Kept separate and total so it can be tested directly without touching the network.
 */
function extractHost(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  // Tolerate a pasted URL.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/)[0];

  // Discard the local part of an address. Everything before the last `@` goes, and is not retained
  // anywhere, including in error messages.
  const at = value.lastIndexOf('@');
  if (at !== -1) value = value.slice(at + 1);

  // Strip a port and any surrounding brackets from an IPv6 literal.
  value = value.replace(/^\[|\]$/g, '');
  value = value.replace(/:\d+$/, '');
  value = value.replace(/\.$/, '');

  return value || null;
}

/**
 * Every rejection that can be decided without a suffix list, and otherwise the host to carry on with.
 *
 * The order matters and matches the order the messages get more specific in: an empty box is not a
 * malformed domain, and an overlong paste is not worth parsing before saying so.
 */
export function readHost(raw: string): SyntaxResult {
  if (!raw || !raw.trim()) {
    return { kind: 'rejected', reason: 'empty', explanation: 'Enter a domain or an email address.' };
  }
  if (raw.length > MAX_INPUT_LENGTH * 2) {
    return { kind: 'rejected', reason: 'too_long', explanation: 'That input is too long to be a domain.' };
  }

  const fromEmailAddress = raw.includes('@');
  const host = extractHost(raw);

  if (!host) {
    return { kind: 'rejected', reason: 'malformed', explanation: 'That does not look like a domain.' };
  }
  if (host.length > MAX_INPUT_LENGTH) {
    return { kind: 'rejected', reason: 'too_long', explanation: 'That input is too long to be a domain.' };
  }
  if (isIpLiteral(host)) {
    return {
      kind: 'rejected',
      reason: 'ip_address',
      explanation: 'IP addresses have no registration or mail configuration to analyse.',
    };
  }
  if (isReservedName(host)) {
    return {
      kind: 'rejected',
      reason: 'localhost',
      explanation: 'Reserved and special-use names have no public registration to analyse.',
    };
  }

  return { kind: 'ok', host, fromEmailAddress };
}
