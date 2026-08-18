import { describe, expect, it } from 'vitest';
import { collectMail } from '@/lib/collect/mail';
import { restoreFetchBetweenTests, stubNetwork } from './helpers/network';

/**
 * The BIMI certificate fetch, which is the one request in the system aimed by the domain being analysed.
 *
 * Everything else here is either a committed table or a URL this process composed from a host that
 * already passed `normaliseInput`. The `a=` tag is neither: it is a URL read out of a TXT record, and
 * the gate in front of it — an enforcing DMARC policy — is a record the same domain publishes. So a
 * domain that wants this server to make a request of its choosing needs only to publish two records and
 * submit itself for analysis, which is the form the tool invites.
 *
 * `verifyVmc` is tested separately and offline in `bimi-vmc.test.ts`. These tests are about which
 * addresses the collector is willing to dial at all, and about saying so in terms a reader can act on:
 * "could not be retrieved" would describe a certificate we never asked for.
 */

restoreFetchBetweenTests();

const CERT_HOST_PATH = '/vmc.pem';

/** A resolver reply for the two names `collectBimi` depends on, and nothing else. */
function zone(bimiRecord: string) {
  return stubNetwork((url) => {
    const name = new URL(url).searchParams.get('name') ?? '';

    if (name.startsWith('_dmarc.')) return txt(name, 'v=DMARC1; p=reject');
    if (name.startsWith('default._bimi.')) return txt(name, bimiRecord);
    // Every other lookup the mail collector makes: DKIM selectors and the reporting-vendor check.
    return txt(name);
  });
}

function txt(name: string, ...records: string[]): Response {
  return new Response(
    JSON.stringify({
      Status: 0,
      Answer: records.map((record) => ({ name: `${name}.`, type: 16, TTL: 300, data: `"${record}"` })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function bimiFor(record: string) {
  const { urls } = zone(record);
  const mail = await collectMail('example.com', undefined, 4_000);
  return { bimi: mail.bimi, fetched: urls.filter((url) => url.includes(CERT_HOST_PATH)) };
}

describe('the certificate address a BIMI record names', () => {
  it.each([
    ['a link-local address', `https://169.254.169.254${CERT_HOST_PATH}`],
    ['a loopback address', `https://127.0.0.1${CERT_HOST_PATH}`],
    ['a private address', `https://10.0.0.1${CERT_HOST_PATH}`],
    ['an integer address', `https://2130706433${CERT_HOST_PATH}`],
    ['a reserved name', `https://vault.internal${CERT_HOST_PATH}`],
  ])('is never requested when it names %s', async (_case, certificateUrl) => {
    const { bimi, fetched } = await bimiFor(`v=BIMI1; l=https://example.com/logo.svg; a=${certificateUrl}`);

    expect(fetched).toEqual([]);
    expect(bimi?.record).toBe(true);
    expect(bimi?.verified).toBe(false);
    expect(bimi?.failure).toBe('refused_address');
  });

  /**
   * The BIMI specification requires HTTPS for the evidence document, so this needs no security argument
   * of its own — but it is also the case that `file:` and `http:` are how a refusal gets bypassed by a
   * record that keeps its host public and changes the scheme instead.
   */
  it.each([
    ['a file URL', 'file:///etc/passwd'],
    ['a plaintext URL', `http://example.com${CERT_HOST_PATH}`],
    ['something that is not a URL at all', 'not-a-url'],
  ])('is never requested when it names %s', async (_case, certificateUrl) => {
    const { bimi, fetched } = await bimiFor(`v=BIMI1; a=${certificateUrl}`);

    expect(fetched).toEqual([]);
    expect(bimi?.failure).toBe('refused_address');
  });

  it('reports a refusal differently from an address that was tried and did not answer', async () => {
    const refused = await bimiFor(`v=BIMI1; a=https://127.0.0.1${CERT_HOST_PATH}`);
    expect(refused.bimi?.failure).toBe('refused_address');

    const { urls } = stubNetwork((url) => {
      const name = new URL(url).searchParams.get('name');
      if (name === null) return new Response('', { status: 500 });
      if (name.startsWith('_dmarc.')) return txt(name, 'v=DMARC1; p=reject');
      if (name.startsWith('default._bimi.')) {
        return txt(name, `v=BIMI1; a=https://mark.example.com${CERT_HOST_PATH}`);
      }
      return txt(name);
    });
    const mail = await collectMail('example.com', undefined, 4_000);

    expect(mail.bimi?.failure).toBe('unreachable');
    // The distinction is only meaningful if the reachable one was actually reached.
    expect(urls.filter((url) => url.includes(CERT_HOST_PATH))).toHaveLength(1);
  });

  it('keeps the address it refused, so a reader can see what was published', async () => {
    const target = `https://169.254.169.254${CERT_HOST_PATH}`;
    const { bimi } = await bimiFor(`v=BIMI1; a=${target}`);

    expect(bimi?.certificateUrl).toBe(target);
  });

  /**
   * The gate that makes the whole query cheap. Without an enforcing policy there is no BIMI lookup at
   * all, which is the reason a certificate fetch happens on roughly one analysis in nine hundred.
   */
  it('is not looked up at all behind a DMARC policy of none', async () => {
    const { urls } = stubNetwork((url) => {
      const name = new URL(url).searchParams.get('name') ?? '';
      if (name.startsWith('_dmarc.')) return txt(name, 'v=DMARC1; p=none');
      return txt(name);
    });

    const mail = await collectMail('example.com', undefined, 4_000);

    expect(mail.bimi).toBeUndefined();
    expect(urls.filter((url) => url.includes('_bimi'))).toEqual([]);
  });
});
