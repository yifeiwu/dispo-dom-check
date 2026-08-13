import { X509Certificate, createHash } from 'node:crypto';
import { TRUSTED_ANCHOR_KEYS, authorityFor, type VmcFailure } from './data/bimi-authorities';

export { VMC_FAILURE_REASONS, describeVmcFailure, type VmcFailure } from './data/bimi-authorities';

/**
 * Verification of a BIMI Verified Mark Certificate.
 *
 * `mail.bimi` was removed in 1.3.0 for checking that a TXT record began with `v=BIMI1`, which prices a
 * string anyone can publish. What makes BIMI worth reading is not the record but the certificate the
 * record points at: a VMC requires a registered trademark, proof of control over it, and about a
 * thousand dollars a year. None of that is inherited by a domain that merely says `v=BIMI1`, and the
 * whole difference between the removed signal and this one is that the certificate is actually checked.
 *
 * Pure over a PEM string and a domain, with an injectable clock, so every rejection path is testable
 * offline against committed fixtures. Nothing here performs I/O.
 */

/**
 * A certificate subject is a long string of jurisdictions, street addresses and trademark registration
 * numbers. The common or organisation name is the part a reader recognises, and the only part worth
 * putting in a sentence.
 */
function shortName(distinguishedName: string): string {
  const parts = distinguishedName.split('\n').map((part) => part.trim());
  const valueOf = (key: string) =>
    parts.find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);
  const name = valueOf('CN') ?? valueOf('O') ?? distinguishedName.replace(/\n/g, ', ');
  // Distinguished names escape commas inside a value, which is noise once the field is on its own.
  return name.replace(/\\,/g, ',').trim();
}

/** `Aug 11 23:59:59 2026 GMT` is how X.509 states a date and not how anyone reads one. */
function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export type VmcResult = {
  verified: boolean;
  /** The Mark Verifying Authority, where the chain reached one. */
  issuer?: string;
  /** The mark holder, for display beside a verdict. */
  subject?: string;
  failure?: VmcFailure;
  /** Human-readable detail for the evidence string, never used for control flow. */
  detail?: string;
};

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Pins the key rather than the certificate, so an authority re-issuing its root does not break this. */
export function publicKeyFingerprint(certificate: X509Certificate): string {
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

function fail(failure: VmcFailure, detail?: string): VmcResult {
  return { verified: false, failure, detail };
}

export type VmcOptions = {
  /** Injectable so an expiry test does not become a test that passes until a fixture ages out. */
  now?: Date;
  /**
   * Overrides the shipped anchor set. Exists for the tests, which pin their own throwaway root; the
   * collector never passes it.
   */
  anchors?: readonly { sha256: string; authority: string }[];
};

/**
 * Verifies a PEM bundle as a VMC for `domain`.
 *
 * The bundle is expected leaf-first, which is what every VMC endpoint serves and what TLS itself
 * requires. The checks are ordered so the returned failure names the most specific thing wrong: an
 * expired certificate reports `expired` rather than being swallowed by a later chain error.
 */
export function verifyVmc(pem: string, domain: string, options: VmcOptions = {}): VmcResult {
  const now = options.now ?? new Date();
  const anchors = options.anchors ?? TRUSTED_ANCHOR_KEYS;
  const blocks = pem.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0) return fail('empty_bundle');

  const chain: X509Certificate[] = [];
  for (const block of blocks) {
    try {
      chain.push(new X509Certificate(block));
    } catch {
      return fail('unparseable');
    }
  }

  const leaf = chain[0];
  const subject = shortName(leaf.subject);

  /*
   * Every certificate in the chain has to be current, not just the leaf. An expired intermediate is
   * every bit as fatal and is the likelier of the two to go unnoticed, since nobody is reminded of it.
   * The detail says which certificate lapsed, because "the intermediate expired" and "the mark holder
   * let theirs lapse" are different problems belonging to different people.
   */
  for (const [index, certificate] of chain.entries()) {
    const which = index === 0 ? 'it' : `the certificate for ${shortName(certificate.subject)} above it`;
    if (new Date(certificate.validTo) < now) {
      return { ...fail('expired', `${which} expired on ${formatDate(certificate.validTo)}`), subject };
    }
    if (new Date(certificate.validFrom) > now) {
      return {
        ...fail('not_yet_valid', `${which} is not valid until ${formatDate(certificate.validFrom)}`),
        subject,
      };
    }
  }

  /*
   * The certificate has to be for this domain. Without this the whole thing is a copy-and-paste: any
   * genuine VMC is publicly fetchable, so a domain could point `a=` at a large brand's certificate and
   * inherit its verification. `checkHost` reads subject alternative names and falls back to the common
   * name, which is the same rule a TLS client applies.
   */
  if (!leaf.checkHost(domain)) {
    const covers = leaf.subjectAltName?.replace(/DNS:/g, '') ?? shortName(leaf.subject);
    return {
      ...fail('subject_mismatch', `it covers ${covers} rather than ${domain}, and was issued to ${subject}`),
      subject,
    };
  }

  /*
   * A lone self-signed certificate is the cheapest possible forgery and deserves its own failure name,
   * since `broken_chain` would describe it misleadingly — nothing is broken, there is simply no issuer
   * other than the applicant.
   */
  if (chain.length === 1 && leaf.subject === leaf.issuer) {
    return { ...fail('self_signed', `${subject} is named as both the holder and the issuer`), subject };
  }

  /*
   * Each link is checked twice on purpose. `checkIssued` compares names and authority key identifiers,
   * which is a claim about who issued it; `verify` checks the signature against the parent's key, which
   * is proof. The first alone is forgeable and the second alone would accept a chain assembled in the
   * wrong order.
   */
  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
      return {
        ...fail(
          'broken_chain',
          `the link from ${shortName(child.subject)} to ${shortName(parent.subject)} does not hold`,
        ),
        subject,
      };
    }
  }

  const top = chain[chain.length - 1];
  const authority = authorityFor(top.issuer) ?? authorityFor(top.subject);
  if (!authority) {
    return {
      ...fail('issuer_not_an_authority', `the chain ends at ${shortName(top.issuer)}`),
      subject,
    };
  }

  /*
   * The check that makes the rest mean anything. Everything above proves the bundle is internally
   * consistent, which a forger producing their own root and leaf would also satisfy — including the
   * name check, since a certificate's issuer name is a string it asserts about itself. Tying the chain
   * to a key a Mark Verifying Authority is known to sign with is what a forger cannot do.
   *
   * Any certificate above the leaf may carry the pinned key, rather than only the last one, because
   * publishers do not agree on how much of the chain to serve. Eighteen of the twenty chains in the
   * verification set climb all the way to a root; Entrust's stops at its issuing CA. Pinning strictly
   * at the top would reject the shorter bundle for being shorter. The leaf itself is excluded because a
   * leaf whose key is an authority's is not a mark holder's certificate at all.
   *
   * This is sound because every consecutive link was verified above: if any certificate above the leaf
   * carries a pinned key, the leaf descends from that key by a chain of checked signatures.
   */
  const pinned = chain
    .slice(1)
    .map((certificate) => anchors.find((candidate) => candidate.sha256 === publicKeyFingerprint(certificate)))
    .find(Boolean);
  if (!pinned) {
    return {
      ...fail(
        'untrusted_anchor',
        `it names ${authority} as the issuer, but the chain ends at a key ${shortName(top.subject)} holds that is not one ${authority} is known to use`,
      ),
      subject,
      issuer: authority,
    };
  }

  return { verified: true, issuer: pinned.authority, subject };
}

/**
 * Parses a BIMI TXT record into its tags.
 *
 * `l=` is the logo and `a=` the certificate. A record with a logo and no `a=` is valid BIMI and is
 * exactly the unverified case this signal must not pay for: it asserts a logo with nothing standing
 * behind it.
 */
export function parseBimiRecord(record: string): { logoUrl?: string; certificateUrl?: string } | null {
  const trimmed = record.trim().replace(/^"|"$/g, '');
  if (!/^v\s*=\s*BIMI1\b/i.test(trimmed)) return null;
  const tags: Record<string, string> = {};
  for (const part of trimmed.split(';')) {
    const [name, ...rest] = part.split('=');
    if (!name || rest.length === 0) continue;
    tags[name.trim().toLowerCase()] = rest.join('=').trim();
  }
  return {
    logoUrl: tags.l || undefined,
    certificateUrl: tags.a || undefined,
  };
}
