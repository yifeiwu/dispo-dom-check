import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/analyze/route';

/**
 * The endpoint's rejection paths, which are the ones that answer without doing any work.
 *
 * Every request here carries an input the boundary refuses, so `normaliseInput` returns before a
 * collector is reached and nothing touches the network. That is what makes the rate limit testable at
 * all: the brake is applied ahead of the analysis, so twenty refusals fill a client's window exactly as
 * twenty analyses would.
 */

function analyse(domain: string, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request('https://scorer.test/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ domain }),
    }),
  );
}

/** A distinct client per test, since the limiter's window outlives any one of them. */
function from(ip: string) {
  return { 'x-forwarded-for': ip };
}

describe('rate limiting', () => {
  it('refuses a client that exceeds its window, and says when to come back', async () => {
    const client = from('198.51.100.1');
    for (let i = 0; i < 20; i += 1) await analyse('not a domain', client);

    const refused = await analyse('not a domain', client);

    expect(refused.status).toBe(429);
    // Without this a refused caller has to guess, and a bad guess is the behaviour being braked.
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('counts a client identified only by x-real-ip', async () => {
    const client = { 'x-real-ip': '198.51.100.2' };
    for (let i = 0; i < 20; i += 1) await analyse('not a domain', client);

    expect((await analyse('not a domain', client)).status).toBe(429);
  });

  /**
   * The failure this guards against is not one heavy client getting through, it is every light one being
   * shut out. Collapsed into a single `unknown` bucket, twenty unattributable requests from anywhere
   * refuse the next caller who also arrives without a forwarding header — turning a courtesy brake on
   * the upstreams into an outage for everyone behind it.
   */
  it('does not pool every unattributable caller into one shared allowance', async () => {
    for (let i = 0; i < 25; i += 1) {
      expect((await analyse('not a domain')).status).toBe(400);
    }
  });

  it('keeps two clients apart', async () => {
    for (let i = 0; i < 21; i += 1) await analyse('not a domain', from('198.51.100.3'));

    expect((await analyse('not a domain', from('198.51.100.4'))).status).toBe(400);
  });
});

describe('cache headers', () => {
  it('marks a rejection uncacheable, not only a result', async () => {
    const rejected = await analyse('not a domain', from('198.51.100.5'));

    expect(rejected.status).toBe(400);
    // An intermediary holding this would answer a later request about a different domain.
    expect(rejected.headers.get('cache-control')).toBe('no-store');
  });

  it('marks a refusal uncacheable, so it cannot outlive the window that caused it', async () => {
    const client = from('198.51.100.6');
    for (let i = 0; i < 20; i += 1) await analyse('not a domain', client);

    const refused = await analyse('not a domain', client);

    expect(refused.status).toBe(429);
    expect(refused.headers.get('cache-control')).toBe('no-store');
  });

  it('marks an out-of-scope verdict uncacheable', async () => {
    const response = await analyse('gmail.com', from('198.51.100.7'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verdict: 'out_of_scope' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
