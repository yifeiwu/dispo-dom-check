/**
 * The parts of a registration record that are derived rather than read.
 *
 * Shared by the two collectors that can produce one. RDAP and WHOIS disagree about almost everything at
 * the wire level, but a creation date and an expiry date mean the same thing in both, and the arithmetic
 * turning them into a term is where a subtle difference between the two would be hardest to notice and
 * most damaging: the age dimension would quietly score a `.it` domain on a different basis from a `.com`
 * one. Deriving both from one function makes that impossible by construction.
 */

const YEAR_MS = 31_557_600_000;

export type RegistrationPeriods = {
  /**
   * The purchased term, which can only be derived while the domain is still inside its first period.
   * Beyond that, creation-to-expiry spans every renewal and says nothing about the original commitment.
   */
  termYears?: number;
  /**
   * How far ahead the registration is paid, measured from now.
   *
   * This is the honest multi-year-commitment figure. Taking expiry minus creation instead would report a
   * domain registered decades ago and renewed annually as having a thirty-year term, which is meaningless:
   * neither source exposes a record of what was actually purchased, only when the current period ends.
   */
  yearsUntilExpiry?: number;
};

export function derivePeriods(
  creation: string | undefined,
  expiry: string | undefined,
  now: number = Date.now(),
): RegistrationPeriods {
  const createdAt = creation ? Date.parse(creation) : NaN;
  const expiresAt = expiry ? Date.parse(expiry) : NaN;

  const yearsUntilExpiry = Number.isFinite(expiresAt)
    ? Math.round(((expiresAt - now) / YEAR_MS) * 10) / 10
    : undefined;

  const ageYears = Number.isFinite(createdAt) ? (now - createdAt) / YEAR_MS : undefined;
  const termYears =
    Number.isFinite(createdAt) && Number.isFinite(expiresAt) && ageYears !== undefined && ageYears <= 1.05
      ? Math.round(((expiresAt - createdAt) / YEAR_MS) * 10) / 10
      : undefined;

  return { termYears, yearsUntilExpiry };
}

/**
 * Privacy and proxy services in the registrant organisation field. A redacted registrant is the norm and
 * never a penalty; this exists only so that a redaction service name is not mistaken for a real company.
 */
const PRIVACY_ORG_MARKERS = [
  'privacy',
  'redacted',
  'not disclosed',
  'data protected',
  'withheld',
  'proxy',
  'whoisguard',
  'protection service',
  'anonymize',
  'identity shield',
  'domains by',
  'contact privacy',
  'perfect privacy',
  'private by design',
  'gdpr',
  'statutory masking',
];

export function isPrivacyService(org: string | undefined): boolean | undefined {
  if (!org) return undefined;
  const lowered = org.toLowerCase();
  return PRIVACY_ORG_MARKERS.some((marker) => lowered.includes(marker));
}
