import { matchMx } from '../data/mx-match';
import { TEMP_MAIL_MX } from '../data/temp-mail-mx';
import { FORWARDER_MX } from '../data/forwarder-mx';
import {
  CLOUDFLARE_ROUTING,
  CONSUMER_MAIL_INFRASTRUCTURE_MX,
  FREE_MAIL_ROUTING_MX,
  PAID_MAIL_MX,
} from '../data/free-mail-routing';
import { resolveA } from './dns';
import type { DnsFacts, SignupFacts } from '../facts';

/**
 * Signup capability: the primary dimension.
 *
 * The question is whether this domain can mint unlimited deliverable addresses cheaply. Since SMTP port
 * 25 is unavailable from the deployment target, catch-all capability cannot be probed directly, so the
 * substitute is classifying the domain's mail configuration by provider class. That turns out to be
 * better than a probe anyway, because it generalises: an operator rotating throwaway front-end domains
 * keeps pointing them at the same mail exchangers.
 *
 * Classification is ordered by severity, since a domain can match more than one table and the most
 * consequential class should win.
 */
export async function collectSignup(
  domain: string,
  dns: DnsFacts | undefined,
  spfRecord: string | undefined,
  timeoutMs: number,
): Promise<SignupFacts> {
  const mxHosts = (dns?.mx ?? []).map((entry) => entry.host);

  if (mxHosts.length === 0) {
    // No inbound mail configured. This is explicitly *not* a penalty: an account farmer must receive
    // the verification message, so working mail is a precondition of the abuse rather than evidence of
    // it, and a domain that cannot receive mail fails at the verification step anyway.
    return { class: 'none', selfHosted: false };
  }

  const tempMail = matchMx(mxHosts, TEMP_MAIL_MX);
  if (tempMail) {
    return {
      class: 'temp_mail',
      provider: tempMail.fingerprint.provider,
      matchedHost: tempMail.matchedHost,
      selfHosted: false,
    };
  }

  const freeRouting = matchMx(mxHosts, FREE_MAIL_ROUTING_MX);
  if (freeRouting) {
    return {
      class: 'free_routing',
      provider: freeRouting.fingerprint.provider,
      matchedHost: freeRouting.matchedHost,
      corroboration: await corroborateRouting(freeRouting.matchedHost, spfRecord, timeoutMs),
      selfHosted: false,
    };
  }

  const forwarder = matchMx(mxHosts, FORWARDER_MX);
  if (forwarder) {
    return {
      class: 'forwarder',
      provider: forwarder.fingerprint.provider,
      matchedHost: forwarder.matchedHost,
      selfHosted: false,
    };
  }

  // Checked before the paid table, because a large free provider's own infrastructure would otherwise
  // read as a paid business tenant on one of its vanity domains.
  const consumer = matchMx(mxHosts, CONSUMER_MAIL_INFRASTRUCTURE_MX);
  if (consumer) {
    return {
      class: 'consumer_infrastructure',
      provider: consumer.fingerprint.provider,
      matchedHost: consumer.matchedHost,
      selfHosted: false,
    };
  }

  const paid = matchMx(mxHosts, PAID_MAIL_MX);
  if (paid) {
    return {
      class: 'paid_tenant',
      provider: paid.fingerprint.provider,
      matchedHost: paid.matchedHost,
      selfHosted: false,
    };
  }

  // Mail handled inside the domain's own namespace. Common for both a small business running its own
  // server and a temp-mail operator running one, so it scores neutrally and the surrounding signals
  // decide.
  const selfHosted = mxHosts.some((host) => host === domain || host.endsWith(`.${domain}`));
  return {
    class: selfHosted ? 'self_hosted' : 'unknown_host',
    matchedHost: mxHosts[0],
    selfHosted,
  };
}

/**
 * Confirms the dominant free-routing fingerprint two further ways, both verified during design: every
 * routing target resolves inside one small IPv4 prefix, and the provider publishes a well-known SPF
 * include. Corroboration exists because this one fingerprint carries more weight than any other, so it
 * should not rest on a hostname suffix alone.
 *
 * Returning `undefined` rather than an empty array is the whole point of the signature. An empty array
 * is a finding — both checks ran and neither agreed — whereas a provider with nothing to check against
 * and a check the network cut short are both silence, and the governing rule is that silence never
 * moves the score.
 */
async function corroborateRouting(
  matchedHost: string,
  spfRecord: string | undefined,
  timeoutMs: number,
): Promise<string[] | undefined> {
  if (!matchedHost.endsWith(CLOUDFLARE_ROUTING.mxSuffix)) return undefined;

  const corroboration: string[] = [];

  if (spfRecord?.includes(CLOUDFLARE_ROUTING.spfInclude)) {
    corroboration.push(`SPF includes the provider's routing sender policy`);
  }

  try {
    const addresses = await resolveA(matchedHost, Math.min(timeoutMs, 1500));
    if (addresses.some((address) => address.startsWith(CLOUDFLARE_ROUTING.targetPrefix))) {
      corroboration.push('Mail exchanger resolves inside the provider\'s dedicated routing prefix');
    }
  } catch {
    // The resolver did not answer, so this check has no result either way. Reporting that as a
    // disagreement would let a timeout discount a match that nothing actually contradicted.
    if (corroboration.length === 0) return undefined;
  }

  return corroboration;
}
