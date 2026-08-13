import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectCheckMail } from '@/lib/collect/checkmail';
import { runCollector } from '@/lib/collector';

/**
 * The reputation collector is the only source in the system that costs money per call and the only one
 * whose answer is a third party's conclusion rather than an observation. Both facts shape what is
 * pinned here.
 *
 * The sample body below is the vendor's own documented example, trimmed of the fields this model does
 * not read. Everything the parser is asserted against comes from that document rather than from a live
 * call, so the suite never needs a key and never spends an allowance.
 */

const originalFetch = globalThis.fetch;
const KEY = 'test-key';

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The documented response for a known disposable domain. */
const DISPOSABLE_BODY = {
  valid: true,
  block: true,
  domain: 'temp-mail.example',
  base_domain: 'temp-mail.example',
  text: 'Disposable / temporary domain',
  reason: 'Heuristics x5',
  risk: 99,
  is_disposable: true,
  is_email_forwarder: false,
  disposable_provider: 'temp-mail.example',
};

function stub(
  responder: (url: string, init: RequestInit) => Response,
): { calls: () => { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responder(String(url), init));
  });
  return { calls: () => calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('authentication and the absent key', () => {
  it('reports unsupported rather than failing when no key is configured', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', '');
    const network = stub(() => json(DISPOSABLE_BODY));

    const result = await runCollector('checkmail', undefined, () =>
      collectCheckMail('example.com', 1000),
    );

    // The distinction that matters: a source nobody configured is not a source that broke, and a fresh
    // clone with no account has to score every other dimension exactly as it did before.
    expect(result.status).toBe('unsupported');
    expect(result.reason).toMatch(/no Check-Mail API key/i);
    expect(network.calls()).toHaveLength(0);
  });

  it('sends the domain as form data under a bearer token, and never a local part', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', KEY);
    const network = stub(() => json(DISPOSABLE_BODY));

    await collectCheckMail('temp-mail.example', 1000);

    const [call] = network.calls();
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe('domain=temp-mail.example');
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
  });
});

describe('parsing the verdict', () => {
  it('reads the disposable verdict, its risk score and the named operator', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', KEY);
    stub(() => json(DISPOSABLE_BODY));

    const { facts } = await collectCheckMail('temp-mail.example', 1000);

    expect(facts).toMatchObject({
      disposable: true,
      risk: 99,
      block: true,
      valid: true,
      forwarder: false,
      provider: 'temp-mail.example',
    });
  });

  it('records the parent name only when the vendor answered about something else', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', KEY);
    stub(() => json({ ...DISPOSABLE_BODY, base_domain: 'pages.example' }));

    // A platform-issued name is answered at its parent, and a penalty presented as though it belonged
    // to the subdomain would be attributed to a name that did nothing.
    const parent = await collectCheckMail('someone.pages.example', 1000);
    expect(parent.facts.baseDomain).toBe('pages.example');

    stub(() => json(DISPOSABLE_BODY));
    const same = await collectCheckMail('temp-mail.example', 1000);
    expect(same.facts.baseDomain).toBeUndefined();
  });

  it('surfaces the remaining monthly allowance so exhaustion is visible before it happens', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', KEY);
    stub(() => json(DISPOSABLE_BODY, { headers: { 'x-ratelimit-requests-remaining': '12' } }));

    const { notice } = await collectCheckMail('temp-mail.example', 1000);
    expect(notice).toBe("12 lookups left in this month's allowance");
  });
});

describe('failures are classified rather than swallowed', () => {
  it('reads a 429 as the monthly allowance being spent', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', KEY);
    stub(() => new Response('', { status: 429 }));

    const result = await runCollector('checkmail', undefined, () =>
      collectCheckMail('example.com', 1000),
    );
    expect(result.status).toBe('rate_limited');
    expect(result.reason).toMatch(/allowance is exhausted/);
  });

  it('reads a 401 as the source being unavailable', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', 'wrong');
    stub(() => new Response('', { status: 401 }));

    const result = await runCollector('checkmail', undefined, () =>
      collectCheckMail('example.com', 1000),
    );
    expect(result.status).toBe('unavailable');
  });

  /*
   * The documented failure shape for a rejected key is a 200 carrying a message and no verdict. Parsed
   * loosely it would produce `disposable: false, risk: 0` for every domain, which is not a missing
   * answer but a clean bill of health issued to the entire internet, credit included.
   */
  it('refuses a 200 that carries no verdict', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', 'wrong');
    stub(() => json({ message: 'Invalid API key.' }));

    const result = await runCollector('checkmail', undefined, () =>
      collectCheckMail('example.com', 1000),
    );
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('Invalid API key.');
  });

  it('falls back to GET when the endpoint rejects the documented POST', async () => {
    vi.stubEnv('CHECKMAIL_API_KEY', KEY);
    // The vendor's auth page documents POST while its homepage and FAQ describe GET, so the collector
    // must not depend on which of the two is current.
    const network = stub((url) =>
      url.includes('?') ? json(DISPOSABLE_BODY) : new Response('', { status: 405 }),
    );

    const { facts } = await collectCheckMail('temp-mail.example', 1000);
    expect(facts.disposable).toBe(true);

    const [post, get] = network.calls();
    expect(post.init.method).toBe('POST');
    expect(get.init.method).toBeUndefined();
    expect(get.url).toContain('domain=temp-mail.example');
  });
});
