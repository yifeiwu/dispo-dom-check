import { normaliseHostname } from '../hostname';
import type { RegistrationFacts } from '../facts';

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

/**
 * What each collector has after parsing its own wire format, before the derived fields are added.
 *
 * `statuses` arrives already tokenised, because that step is genuinely protocol-specific and must stay
 * so: RDAP publishes `client transfer prohibited` with spaces, while port-43 publishes
 * `clientTransferProhibited https://icann.org/epp#clientTransferProhibited` and has to be cut at the
 * first token. They converge on one vocabulary by different routes, and collapsing them into a single
 * normaliser would break whichever format it was not written for.
 */
export type ParsedRegistration = {
  via: RegistrationFacts['via'];
  creation?: string;
  expiry?: string;
  lastChanged?: string;
  /** Already lowercased and tokenised by the caller. */
  statuses: readonly string[];
  registrar?: string;
  registrarIanaId?: string;
  registrantOrg?: string;
  /** Raw exchange names; normalised and deduplicated here. */
  nameservers: readonly (string | undefined)[];
};

/**
 * Assembles a registration record from either protocol.
 *
 * RDAP and WHOIS reach the same nine fields by entirely different routes, and each used to finish by
 * writing out the same object literal. Two copies of an assembly step is how the two sources drift
 * into disagreeing about a domain for reasons that have nothing to do with what the registry said —
 * which is the same argument `derivePeriods` was already extracted on, applied to the rest of the
 * record.
 */
export function buildRegistrationFacts(
  parsed: ParsedRegistration,
  now: number = Date.now(),
): RegistrationFacts {
  return {
    via: parsed.via,
    creation: parsed.creation,
    expiry: parsed.expiry,
    lastChanged: parsed.lastChanged,
    statuses: [...parsed.statuses],
    registrar: parsed.registrar,
    registrarIanaId: parsed.registrarIanaId,
    registrantOrg: parsed.registrantOrg,
    registrantIsPrivacyService: isPrivacyService(parsed.registrantOrg),
    nameservers: [
      ...new Set(
        parsed.nameservers
          .map((value) => normaliseHostname(value))
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    ...derivePeriods(parsed.creation, parsed.expiry, now),
  };
}
