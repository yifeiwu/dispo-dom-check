import { fetchJson } from '../fetch';
import { withBackgroundRefresh } from '../reference-cache';
import { UnsupportedError } from '../errors';
import { buildRegistrationFacts } from './registration';
import type { RegistrationFacts } from '../facts';

/**
 * RDAP: the anchor signal, because registration date is the one hard fact about a domain's age.
 *
 * The registry endpoint is discovered from the IANA bootstrap rather than through a redirector service,
 * which timed out repeatedly during design. Not every suffix publishes RDAP at all: roughly 240 of the
 * root zone's suffixes have no service, and those raise `UnsupportedError`.
 *
 * That error is now a routing decision rather than the end of the matter. It means "this suffix has no
 * RDAP", which is precisely the condition the port-43 collector exists for, and `analyze` treats it as
 * the trigger to try there. Nothing else does: an RDAP server that exists and fails is a failure, and
 * re-asking a different protocol would double the latency to answer a question that was asked correctly.
 */

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_CACHE_KEY = 'iana:rdap:bootstrap';
const BOOTSTRAP_TTL_SECONDS = 86_400;

type Bootstrap = {
  /** Each service is `[[suffix, ...], [baseUrl, ...]]`. */
  services: [string[], string[]][];
};

/** Static reference data covering roughly 1200 suffixes, so it is fetched once per process. */
async function loadBootstrap(timeoutMs: number): Promise<Bootstrap> {
  return withBackgroundRefresh(BOOTSTRAP_CACHE_KEY, BOOTSTRAP_TTL_SECONDS, timeoutMs, () =>
    fetchJson<Bootstrap>(BOOTSTRAP_URL, { timeoutMs: 15_000 }),
  );
}

/** Finds the RDAP base URL for a suffix, preferring the longest matching suffix entry. */
function findRdapBase(bootstrap: Bootstrap, suffix: string): string | null {
  const labels = suffix.toLowerCase().split('.');
  let best: { length: number; url: string } | null = null;

  for (const [suffixes, urls] of bootstrap.services) {
    for (const entry of suffixes) {
      const candidate = entry.toLowerCase();
      const matches =
        candidate === suffix.toLowerCase() ||
        labels.slice(-candidate.split('.').length).join('.') === candidate;
      if (matches && urls.length > 0) {
        const length = candidate.split('.').length;
        if (!best || length > best.length) {
          best = { length, url: urls[0] };
        }
      }
    }
  }

  return best?.url ?? null;
}

type RdapEvent = { eventAction?: string; eventDate?: string };
type RdapEntity = {
  roles?: string[];
  handle?: string;
  publicIds?: { type?: string; identifier?: string }[];
  vcardArray?: unknown[];
  entities?: RdapEntity[];
};
type RdapNameserver = { ldhName?: string };
type RdapDomain = {
  events?: RdapEvent[];
  status?: string[];
  entities?: RdapEntity[];
  nameservers?: RdapNameserver[];
};

/** Pulls a named field out of a jCard, which is an array-of-arrays rather than an object. */
function vcardField(entity: RdapEntity, field: string): string | undefined {
  const vcard = entity.vcardArray?.[1];
  if (!Array.isArray(vcard)) return undefined;
  for (const item of vcard) {
    if (Array.isArray(item) && item[0] === field) {
      const value = item[3];
      if (typeof value === 'string' && value.trim()) return value.trim();
      // An `adr` field arrives as an array of address components.
      if (Array.isArray(value)) {
        const joined = value.filter((part) => typeof part === 'string' && part).join(', ');
        if (joined) return joined;
      }
    }
  }
  return undefined;
}

function findEntity(entities: RdapEntity[] | undefined, role: string): RdapEntity | undefined {
  if (!entities) return undefined;
  for (const entity of entities) {
    if (entity.roles?.includes(role)) return entity;
    const nested = findEntity(entity.entities, role);
    if (nested) return nested;
  }
  return undefined;
}

function eventDate(events: RdapEvent[] | undefined, action: string): string | undefined {
  const match = events?.find((event) => event.eventAction?.toLowerCase() === action);
  return match?.eventDate;
}

export async function collectRdap(
  domain: string,
  suffix: string,
  timeoutMs: number,
): Promise<{ facts: RegistrationFacts; sourceUrl: string }> {
  const bootstrap = await loadBootstrap(Math.floor(timeoutMs / 2));
  const base = findRdapBase(bootstrap, suffix);

  if (!base) {
    // Deliberately says nothing about the age being unknown any more. It is not this collector's to
    // claim: the port-43 collector runs on exactly this condition and answers for two thirds of the
    // suffixes that reach it.
    throw new UnsupportedError(
      `The .${suffix} registry publishes no RDAP service, so the registration record was sought over WHOIS instead`,
    );
  }

  const sourceUrl = `${base.replace(/\/$/, '')}/domain/${encodeURIComponent(domain)}`;
  const response = await fetchJson<RdapDomain>(sourceUrl, {
    timeoutMs,
    headers: { accept: 'application/rdap+json, application/json' },
  });

  const creation = eventDate(response.events, 'registration');
  const expiry = eventDate(response.events, 'expiration');
  // Strictly `last changed`. The `last update of rdap database` event is a database refresh timestamp
  // that moves constantly, and treating it as a registration change makes every well-run domain look
  // like it just changed hands.
  const lastChanged = eventDate(response.events, 'last changed');

  const registrarEntity = findEntity(response.entities, 'registrar');
  const registrantEntity = findEntity(response.entities, 'registrant');

  const registrantOrg =
    registrantEntity ? (vcardField(registrantEntity, 'org') ?? vcardField(registrantEntity, 'fn')) : undefined;

  return {
    sourceUrl,
    facts: buildRegistrationFacts({
      via: 'rdap',
      creation,
      expiry,
      lastChanged,
      // RDAP spells EPP codes with spaces, so the whitespace comes out rather than being cut at the
      // first token the way a port-43 status line has to be.
      statuses: (response.status ?? []).map((s) => s.toLowerCase().replace(/\s+/g, '')),
      registrar: registrarEntity ? vcardField(registrarEntity, 'fn') : undefined,
      registrarIanaId: registrarEntity?.publicIds?.find((id) => id.type?.includes('IANA'))?.identifier,
      registrantOrg,
      nameservers: (response.nameservers ?? []).map((ns) => ns.ldhName),
    }),
  };
}
