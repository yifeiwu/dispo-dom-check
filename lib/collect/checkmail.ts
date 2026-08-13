import { HttpError, RateLimitedError, UnsupportedError } from '../errors';
import type { CheckMailFacts } from '../facts';
import { probe } from '../fetch';

/**
 * Check-Mail.org, the one source in this system that is somebody else's opinion rather than an
 * observation of the domain.
 *
 * Every other collector reads something the domain itself publishes — a registration record, a DNS
 * zone, a served page — and the model can defend what it concluded from it. This one returns a
 * verdict reached by means the vendor does not disclose, against blocklists and heuristics this
 * repository cannot inspect, measure or reproduce. That is the whole value of it: it sees
 * cross-customer abuse history that no amount of DNS inspection can reach. It is also why the
 * collector is deliberately narrow about what it is willing to carry forward. See `docs/SOURCES.md`.
 *
 * Three properties are worth stating because each is load-bearing:
 *
 * It is metered. The free tier is 1,000 lookups a month, so this is the only source in the system
 * where a request has a marginal cost, and the only one that can go dark partway through a month
 * while every upstream is healthy. `x-ratelimit-requests-remaining` is therefore surfaced on every
 * result, including successful ones, so that exhaustion is visible before it happens rather than
 * being discovered as a wave of `rate_limited` statuses.
 *
 * It is keyed. With no key configured the source reports `unsupported` and the analysis proceeds
 * without it, which is what keeps a fresh clone, the test suite and every calibration run working
 * with no account at all.
 *
 * It answers about a registrable name. For a platform-issued name the vendor answers at the parent,
 * so `base_domain` is carried through and the scorer says so rather than attributing a parent's
 * reputation to a subdomain.
 */

const ENDPOINT = 'https://api.check-mail.org/v2/';

/** The documented shape. Every field is optional, because it is not our schema to rely on. */
type CheckMailResponse = {
  valid?: boolean;
  block?: boolean;
  base_domain?: string;
  text?: string;
  reason?: string;
  risk?: number;
  is_disposable?: boolean;
  is_email_forwarder?: boolean;
  disposable_provider?: string;
  message?: string;
};

export type CheckMailResult = {
  facts: CheckMailFacts;
  sourceUrl: string;
  /** Remaining monthly quota, rendered against the source even when the call succeeded. */
  notice?: string;
};

/**
 * The vendor's auth documentation specifies POST with form data, while its own homepage and FAQ both
 * describe a GET. Rather than pick one and depend on which page is current, POST is tried first and a
 * 405 falls back to GET. The fallback costs a round trip only on an API that has changed under us.
 */
async function ask(
  domain: string,
  key: string,
  timeoutMs: number,
): Promise<{ body: string; status: number; remaining: string | null }> {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${key}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  const form = `domain=${encodeURIComponent(domain)}`;

  const posted = await probe(ENDPOINT, {
    timeoutMs,
    redirect: 'manual',
    method: 'POST',
    body: form,
    headers,
  });

  if (posted.status !== 405) {
    return {
      body: posted.body,
      status: posted.status,
      remaining: posted.headers.get('x-ratelimit-requests-remaining'),
    };
  }

  const got = await probe(`${ENDPOINT}?${form}`, {
    timeoutMs,
    redirect: 'manual',
    headers,
  });
  return {
    body: got.body,
    status: got.status,
    remaining: got.headers.get('x-ratelimit-requests-remaining'),
  };
}

export async function collectCheckMail(domain: string, timeoutMs: number): Promise<CheckMailResult> {
  const key = process.env.CHECKMAIL_API_KEY?.trim();

  if (!key) {
    throw new UnsupportedError(
      'No Check-Mail API key is configured, so no third-party reputation lookup was made',
    );
  }

  const { body, status, remaining } = await ask(domain, key, timeoutMs);

  /*
   * Classified here rather than by `fetchJson`, because the quota reading lives in a response header
   * and `probe` is the only helper that hands headers back. A 429 is the documented signal that the
   * monthly allowance is spent, which is a different thing from the per-second throttling every other
   * source means by it, so the message says which.
   */
  if (status === 429) {
    throw new RateLimitedError('Check-Mail monthly request allowance is exhausted');
  }
  if (status < 200 || status >= 300) {
    throw new HttpError(status, ENDPOINT);
  }

  let parsed: CheckMailResponse;
  try {
    parsed = JSON.parse(body) as CheckMailResponse;
  } catch {
    throw new Error('Check-Mail returned a body that is not JSON');
  }

  // The documented error shape for a bad key is a 200 carrying `{ "message": "Invalid API key." }`,
  // which would otherwise parse into a clean verdict for every domain and quietly credit them all.
  if (parsed.risk === undefined && parsed.is_disposable === undefined) {
    throw new Error(parsed.message ?? 'Check-Mail returned no verdict');
  }

  const base = parsed.base_domain?.toLowerCase();

  return {
    facts: {
      disposable: parsed.is_disposable === true,
      risk: clampRisk(parsed.risk),
      block: parsed.block === true,
      valid: parsed.valid !== false,
      forwarder: parsed.is_email_forwarder === true,
      provider: parsed.disposable_provider || undefined,
      text: parsed.text || undefined,
      reason: parsed.reason || undefined,
      baseDomain: base && base !== domain.toLowerCase() ? base : undefined,
    },
    sourceUrl: ENDPOINT,
    notice: remaining ? `${remaining} lookups left in this month's allowance` : undefined,
  };
}

/** The field is documented as 0-100 and is read into a tier table, so it is bounded before use. */
function clampRisk(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
