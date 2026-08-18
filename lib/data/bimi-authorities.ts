/**
 * The certificate authorities allowed to vouch for a Verified Mark Certificate, and the keys they sign
 * with.
 *
 * Two tables rather than one, because they answer different questions and only one of them is evidence.
 *
 * A VMC is worth reading at all because it is expensive in a way that is hard to fake: the applicant
 * must hold a registered trademark, prove control of it, and pay roughly a thousand dollars a year. That
 * argument holds only for a certificate a Mark Verifying Authority actually issued. A certificate merely
 * *claiming* one did is a file anyone can generate in a second, which is the same defect that removed
 * the original `mail.bimi` in 1.3.0 — it checked that a string began with `v=BIMI1` — reappearing one
 * level up.
 */

/**
 * Distinguished-name fragments identifying the Mark Verifying Authorities.
 *
 * This is a readability check, not a security one. A name in a certificate is a string the certificate
 * asserts about itself, so this narrows the failure message from "untrusted" to "issued by someone who
 * is not an MVA" and does no work beyond that. `TRUSTED_ANCHOR_KEYS` is what actually decides.
 *
 * GlobalSign is here because the verification set found it, not because it was remembered. This table
 * was written with DigiCert and Entrust on the belief that they were the two operating authorities, and
 * `benchmark-bimi` turned up Best Buy chaining to a `GlobalSign Verified Mark Root R42`. It is a fair
 * argument for deriving the list from observation: a list of authorities written from memory is wrong
 * in exactly the direction that rejects genuine certificates, and nothing would have reported it.
 */
export const MARK_VERIFYING_AUTHORITIES: readonly { pattern: string; name: string }[] = [
  { pattern: 'digicert', name: 'DigiCert' },
  { pattern: 'entrust', name: 'Entrust' },
  { pattern: 'globalsign', name: 'GlobalSign' },
];

/**
 * SHA-256 fingerprints of the SubjectPublicKeyInfo of each trust anchor a chain may terminate at.
 *
 * The public key rather than the whole certificate, because an authority re-issues its root with the
 * same key and a longer validity window, and pinning the certificate would expire the signal on a day
 * nobody chose. Verification walks to the top of the supplied bundle and requires the key that signed
 * the last link to be one of these.
 *
 * **An empty table fails every certificate, and that is the intended behaviour rather than an oversight
 * to route around.** Without an anchor, chain verification only proves a bundle is internally
 * consistent, which is exactly what someone forging one would also produce: generate a root naming
 * itself DigiCert, sign a leaf with it, publish both. Every structural check in `verifyVmc` passes on
 * that bundle. So a chain that cannot be tied to a known key is not a weakly verified certificate, it
 * is an unverified one, and the signal must decline to pay for it.
 *
 * Every value here was observed rather than transcribed. `scripts/bimi-anchors.mts` fetched the live
 * chains of the brands in `benchmark-bimi/` and reported which keys they climb to; `supportedBy` is how
 * many unrelated brands in that set agreed on each. That argument is strongest for DigiCert, where
 * eighteen companies with nothing to do with each other chain to one key, and weaker for the two seen
 * once — though the alternative for those is rejecting genuine certificates, and forging one would
 * require the authority's private key rather than merely its name.
 */
export const TRUSTED_ANCHOR_KEYS: readonly {
  sha256: string;
  authority: string;
  subject: string;
  supportedBy: number;
}[] = [
  {
    sha256: 'bb46c35f8e7e67d2e4f34d959b81357b5f35b4977a62e0e6b1d92b4d85ee71a3',
    authority: 'DigiCert',
    subject: 'DigiCert Verified Mark Root CA',
    supportedBy: 18,
  },
  {
    sha256: '2bc481cef67e0f12c3249d449f7d75405e73ece76a7048e9276ce04f5aba7533',
    authority: 'GlobalSign',
    subject: 'GlobalSign Verified Mark Root R42',
    supportedBy: 1,
  },
  {
    /*
     * An issuing CA rather than a root: Entrust's bundle stops one level below the others, which is why
     * verification looks for a pinned key anywhere above the leaf instead of only at the top.
     */
    sha256: '1100cfa424bc73c049a5f2aaf73cd860f5e3c5a11c76ae6e8ae9f663b2623833',
    authority: 'Entrust',
    subject: 'Entrust Verified Mark CA - VMC2',
    supportedBy: 1,
  },
];

export function authorityFor(distinguishedName: string): string | null {
  const haystack = distinguishedName.toLowerCase();
  for (const { pattern, name } of MARK_VERIFYING_AUTHORITIES) {
    if (haystack.includes(pattern)) return name;
  }
  return null;
}

/**
 * Why a BIMI record did not yield a verified mark.
 *
 * The first two are reached before any certificate is parsed and so are raised by the collector rather
 * than by the verifier, but they belong in the same union: to a reader, "the record names no
 * certificate" and "the certificate has expired" are the same kind of answer to the same question, and
 * splitting them across two types would let one of them go undescribed.
 *
 * This vocabulary lives here rather than in `lib/bimi-vmc.ts` for a mundane reason with a real
 * consequence. The scoring registry reaches the browser through a client component, and the verifier
 * imports `node:crypto`; a shared module that dragged the one into the other would put certificate
 * parsing in the bundle. Describing an outcome needs no cryptography, so the description table sits
 * with the rest of the BIMI reference data and the verifier imports it.
 */
export type VmcFailure =
  | 'no_certificate'
  | 'refused_address'
  | 'unreachable'
  | 'unparseable'
  | 'empty_bundle'
  | 'expired'
  | 'not_yet_valid'
  | 'subject_mismatch'
  | 'self_signed'
  | 'broken_chain'
  | 'issuer_not_an_authority'
  | 'untrusted_anchor';

/**
 * What each failure means, in the words a reader of a verdict gets.
 *
 * These are shown rather than logged, so the identifiers above should never reach anyone:
 * `untrusted_anchor` describes the code accurately and tells a reader nothing. Each phrase completes
 * the sentence "the mark could not be verified because …", and each says what is missing rather than
 * only that something is.
 *
 * A total record rather than a lookup with a default, so adding a failure without describing it is a
 * type error rather than a raw identifier nobody notices reaching the page.
 */
export const VMC_FAILURE_REASONS: Record<VmcFailure, string> = {
  no_certificate:
    'the record asks for a logo to be displayed but names no certificate at all, so nothing stands behind the mark',
  refused_address:
    'the record points at an address this checker will not request, such as a private or internal one, so the certificate was never fetched',
  unreachable: 'the certificate it names could not be retrieved',
  empty_bundle: 'the address it names did not return a certificate',
  unparseable: 'the file it names is not a readable certificate',
  expired: 'the certificate has expired',
  not_yet_valid: 'the certificate is not valid yet',
  subject_mismatch:
    'the certificate was issued for a different domain, so it is not this domain’s to display',
  self_signed: 'the certificate issued itself, so no authority vouched for the mark',
  broken_chain: 'a signature in the certificate chain does not hold',
  issuer_not_an_authority:
    'it was issued by a certificate authority that is not authorised to verify marks',
  untrusted_anchor:
    'the chain does not lead to a key any Mark Verifying Authority is known to sign with, which is what a self-issued forgery looks like',
};

/**
 * The failure as a sentence, with whatever specific finding was recorded alongside it.
 *
 * The detail is the part worth having. "The certificate has expired" invites a reader to wonder whether
 * the check is right; "the certificate has expired — it expired on 11 August 2026" settles it. That
 * distinction was not hypothetical here: every rejection among twenty genuine certificates was a lapsed
 * one, two of them within three weeks of the run, and a reader told only that verification failed would
 * reasonably have suspected the verifier.
 */
export function describeVmcFailure(failure: string | undefined, detail?: string): string {
  const reason = VMC_FAILURE_REASONS[failure as VmcFailure] ?? 'the certificate could not be verified';
  return detail ? `${reason} — ${detail}` : reason;
}
