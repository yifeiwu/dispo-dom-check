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
