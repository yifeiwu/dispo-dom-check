import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VMC_FAILURE_REASONS,
  describeVmcFailure,
  parseBimiRecord,
  publicKeyFingerprint,
  verifyVmc,
} from '../lib/bimi-vmc';

/**
 * Verified Mark Certificate verification, tested entirely offline.
 *
 * The fixtures under `test/fixtures/vmc/` were generated once with openssl and committed. They contain
 * no private keys — the keys were destroyed after generation, since the certificates are all that the
 * assertions need and a repository is a poor place to keep signing material.
 *
 * To regenerate: create a self-signed root whose organisation contains `DigiCert`, issue a leaf with
 * `subjectAltName=DNS:example.com`, and concatenate leaf-then-root. The other fixtures are that recipe
 * with one thing wrong in each: dates in the past, a different `subjectAltName`, no issuer above the
 * leaf, an organisation naming no authority, a second root also calling itself DigiCert, and one byte
 * flipped inside the leaf's signature.
 *
 * The reason to test this so closely is that `mail.bimi` was removed in 1.3.0 for accepting anything
 * beginning with `v=BIMI1`. Every rejection below is a way of accidentally rebuilding that signal.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/vmc', name), 'utf8');

/** The fixture root, pinned the way a real Mark Verifying Authority's key would be. */
const TEST_ANCHORS = [
  {
    sha256: publicKeyFingerprint(new X509Certificate(fixture('root.pem'))),
    authority: 'DigiCert',
  },
];

/**
 * Read from the fixture rather than written as a literal, so these tests do not quietly start failing
 * on the day the committed certificates age out. A hardcoded clock would also have to be chosen after
 * the generation date, which is a detail of when someone happened to run openssl.
 */
const validLeaf = new X509Certificate(fixture('valid-chain.pem'));
const NOW = new Date(new Date(validLeaf.validFrom).getTime() + 24 * 60 * 60 * 1000);

describe('VMC verification', () => {
  it('accepts a chain that is current, covers the domain, verifies, and ends at a pinned key', () => {
    const result = verifyVmc(fixture('valid-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(result.verified).toBe(true);
    expect(result.issuer).toBe('DigiCert');
    expect(result.subject).toContain('example.com');
    expect(result.failure).toBeUndefined();
  });

  it('rejects an expired certificate', () => {
    const result = verifyVmc(fixture('expired-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('expired');
  });

  it('rejects a certificate that is not yet valid', () => {
    const result = verifyVmc(fixture('valid-chain.pem'), 'example.com', {
      now: new Date('2000-01-01T00:00:00Z'),
      anchors: TEST_ANCHORS,
    });
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('not_yet_valid');
  });

  /*
   * The copy-and-paste attack, and the one most worth having a test for. Every genuine VMC is publicly
   * fetchable, so without this check a domain could point `a=` at a large brand's certificate and
   * inherit its verification for the price of a DNS record.
   */
  it('rejects a valid certificate belonging to a different domain', () => {
    const result = verifyVmc(fixture('wrong-subject-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('subject_mismatch');
  });

  it('rejects a self-signed certificate', () => {
    const result = verifyVmc(fixture('self-signed.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('self_signed');
  });

  /*
   * This fixture is why the chain is checked with `verify` and not only `checkIssued`: the names and
   * key identifiers still line up, so the issuance claim looks correct and only the signature says
   * otherwise.
   */
  it('rejects a chain whose signature does not verify, even though the names still match', () => {
    const leaf = new X509Certificate(fixture('broken-signature-chain.pem'));
    const root = new X509Certificate(fixture('root.pem'));
    expect(leaf.checkIssued(root)).toBe(true);
    expect(leaf.verify(root.publicKey)).toBe(false);

    const result = verifyVmc(fixture('broken-signature-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('broken_chain');
  });

  it('rejects a chain from an issuer that is not a Mark Verifying Authority', () => {
    const result = verifyVmc(fixture('non-authority-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('issuer_not_an_authority');
  });

  /*
   * The most important test here. This chain is internally perfect — current, covers the domain, every
   * signature verifies, and its root's organisation says DigiCert — and it was generated locally in a
   * second. If name matching were the last check, this would pass, and the signal would be back to
   * pricing a string the domain asserts about itself.
   */
  it('rejects a structurally perfect chain whose root merely calls itself an authority', () => {
    const result = verifyVmc(fixture('forged-authority-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('untrusted_anchor');
  });

  /*
   * The shipped anchor table is empty until the verification set fills it, and an empty table must
   * reject everything rather than wave it through. Fail-closed is the only safe default for a check
   * whose absence silently restores the removed signal.
   */
  it('rejects everything when no anchors are configured', () => {
    const result = verifyVmc(fixture('valid-chain.pem'), 'example.com', { now: NOW, anchors: [] });
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('untrusted_anchor');
  });

  it('rejects input that is not a certificate at all', () => {
    expect(verifyVmc('', 'example.com', { anchors: TEST_ANCHORS }).failure).toBe('empty_bundle');
    expect(verifyVmc('<html>404</html>', 'example.com', { anchors: TEST_ANCHORS }).failure).toBe(
      'empty_bundle',
    );
    const corrupt = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----';
    expect(verifyVmc(corrupt, 'example.com', { anchors: TEST_ANCHORS }).failure).toBe('unparseable');
  });

  it('pins the public key rather than the certificate, so a re-issued root still matches', () => {
    const root = new X509Certificate(fixture('root.pem'));
    expect(publicKeyFingerprint(root)).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyFingerprint(root)).toBe(publicKeyFingerprint(new X509Certificate(root.raw)));
  });
});

/**
 * A rejection nobody can read is a rejection nobody can act on, and the failure identifiers are written
 * for the code rather than for a reader. These pin the translation.
 */
describe('explaining a failure', () => {
  it('describes every failure the verifier can return', () => {
    for (const failure of Object.keys(VMC_FAILURE_REASONS)) {
      const described = describeVmcFailure(failure);
      expect(described, failure).not.toBe(failure);
      expect(described.length, failure).toBeGreaterThan(20);
      // The identifiers are snake_case; none of them should survive into the sentence.
      expect(described, failure).not.toMatch(/_/);
    }
  });

  it('carries the specific finding alongside the general reason', () => {
    const expired = verifyVmc(fixture('expired-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    const described = describeVmcFailure(expired.failure, expired.detail);
    expect(described).toContain('has expired');
    // The date it expired, in words rather than as an X.509 timestamp.
    expect(described).toMatch(/expired on \d+ \w+ \d{4}/);
    expect(described).not.toMatch(/GMT/);
  });

  it('names the domain a borrowed certificate really covers', () => {
    const wrong = verifyVmc(fixture('wrong-subject-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(describeVmcFailure(wrong.failure, wrong.detail)).toContain('someone-else.example');
  });

  /*
   * A real VMC subject runs to jurisdictions, street addresses and trademark registration numbers. The
   * name is the only part worth putting in a sentence, and the rest would swamp the row it appears in.
   */
  it('reduces a certificate subject to the name a reader would recognise', () => {
    const result = verifyVmc(fixture('valid-chain.pem'), 'example.com', {
      now: NOW,
      anchors: TEST_ANCHORS,
    });
    expect(result.subject).toBe('example.com');
    expect(result.subject).not.toMatch(/C=|ST=|O=/);
  });

  it('still says something useful about a failure it does not recognise', () => {
    expect(describeVmcFailure(undefined)).toMatch(/could not be verified/);
    expect(describeVmcFailure('something_new')).not.toMatch(/something_new/);
  });
});

describe('BIMI record parsing', () => {
  it('reads the logo and certificate tags', () => {
    const parsed = parseBimiRecord('v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem');
    expect(parsed?.logoUrl).toBe('https://example.com/logo.svg');
    expect(parsed?.certificateUrl).toBe('https://example.com/vmc.pem');
  });

  /*
   * Valid BIMI, and the exact shape the removed signal paid for. A logo with no certificate is an
   * assertion with nothing behind it, so the parse must succeed while leaving nothing to verify.
   */
  it('reads a record with a logo and no certificate as having none', () => {
    const parsed = parseBimiRecord('v=BIMI1; l=https://example.com/logo.svg;');
    expect(parsed).not.toBeNull();
    expect(parsed?.certificateUrl).toBeUndefined();
  });

  it('ignores records that are not BIMI', () => {
    expect(parseBimiRecord('v=spf1 include:example.com ~all')).toBeNull();
    expect(parseBimiRecord('')).toBeNull();
  });

  it('tolerates quoting and spacing that resolvers introduce', () => {
    const parsed = parseBimiRecord('"v=BIMI1 ; l = https://example.com/logo.svg"');
    expect(parsed?.logoUrl).toBe('https://example.com/logo.svg');
  });
});
