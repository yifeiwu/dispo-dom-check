import type { DnsFacts, RegistrationFacts, RegistrarDefaultFacts, SignupFacts } from '../facts';

type RegistrarDefault = {
  provider: string;
  ianaIds: readonly string[];
  registrarPatterns: readonly string[];
  nameserverPatterns: readonly string[];
  forwardingMxPatterns: readonly string[];
};

/**
 * High-confidence registrar defaults only. A provider belongs here only when the same registrar
 * supplies both its default delegation and catch-all-capable forwarding product.
 */
const REGISTRAR_DEFAULTS: readonly RegistrarDefault[] = [
  {
    provider: 'Namecheap',
    ianaIds: ['1068'],
    registrarPatterns: ['namecheap'],
    nameserverPatterns: ['registrar-servers.com'],
    forwardingMxPatterns: ['registrar-servers.com'],
  },
];

/*
 * Porkbun was drafted as a second entry and dropped. The detector only runs where the mail already
 * classified as free routing, and that registrar's forwarding does not qualify for the free-routing
 * table, so the entry could never have fired; see the note in `lib/data/free-mail-routing.ts`. The
 * requirement that all three components agree is what makes this table safe, and an entry whose third
 * component is unreachable is not a high-confidence default, it is dead code that reads like coverage.
 */

function matchesSuffix(value: string, pattern: string): boolean {
  const normalised = value.toLowerCase().replace(/\.$/, '');
  return normalised === pattern || normalised.endsWith(`.${pattern}`);
}

export function detectRegistrarDefault(
  registration: RegistrationFacts | undefined,
  dns: DnsFacts | undefined,
  signup: SignupFacts | undefined,
): RegistrarDefaultFacts | undefined {
  if (!registration || !dns || signup?.class !== 'free_routing') return undefined;

  for (const entry of REGISTRAR_DEFAULTS) {
    const registrarMatches =
      (registration.registrarIanaId !== undefined && entry.ianaIds.includes(registration.registrarIanaId)) ||
      (registration.registrar !== undefined &&
        entry.registrarPatterns.some((pattern) => registration.registrar!.toLowerCase().includes(pattern)));
    if (!registrarMatches) continue;

    const nameserver = dns.ns.find((host) =>
      entry.nameserverPatterns.some((pattern) => matchesSuffix(host, pattern)),
    );
    const forwardingMx = dns.mx
      .map(({ host }) => host)
      .find((host) => entry.forwardingMxPatterns.some((pattern) => matchesSuffix(host, pattern)));

    if (nameserver && forwardingMx) {
      return { provider: entry.provider, nameserver, forwardingMx };
    }
  }

  return undefined;
}
