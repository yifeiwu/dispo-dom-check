import { describe, expect, it } from 'vitest';
import { collectWhois, parseWhois, parseWhoisDate } from '@/lib/collect/whois';
import { findWhoisServer } from '@/lib/data/whois-servers';
import { derivePeriods } from '@/lib/collect/registration';
import { BUDGET, UnsupportedError } from '@/lib/collector';

/**
 * The WHOIS parser is the one place in the system reading an unversioned text format that differs per
 * registry, so it is tested against responses those registries actually returned rather than against
 * invented ones. Each excerpt below is trimmed for length and otherwise verbatim.
 *
 * The failure mode being guarded is not "no data". It is confidently wrong data: a date read off the
 * wrong record, an availability line inverted, or a throttle message parsed as an empty registration.
 * Each of those produces a score with full weight behind it and nothing to indicate anything was
 * inferred, which is worse than the missing age this collector exists to fix.
 */

/** whois.nic.it. The contact blocks repeat `Created:` with entirely different dates. */
const IT = `
Domain:             google.it
Status:             ok
Signed:             no
Created:            1999-12-10 00:00:00
Last Update:        2026-06-09 23:13:34
Expire Date:        2027-04-21

Registrant
  Organization:     Google Ireland Holdings Unlimited Company
  Created:          2018-03-02 19:04:02
  Last Update:      2018-03-02 19:04:02

Admin Contact
  Name:             Jared Oberhaus
  Organization:     Google LLC
  Created:          2026-06-09 19:22:56
`;

/** whois.dns.be. A registered domain is reported as `NOT AVAILABLE`. */
const BE = `
% .be Whois Server 6.1
%
% By submitting a query you agree not to use the information made available to:
%   - allow, enable or otherwise support the transmission of unsolicited advertising;

Domain:\tgoogle.be
Status:\tNOT AVAILABLE
Registered:\tTue Dec 12 2000

Registrant:
\tNot shown, please visit www.dnsbelgium.be for webbased whois.

Nameservers:
\tns1.google.com
\tns2.google.com
`;

/** whois.denic.de. DENIC publishes a status line and nothing else at all. */
const DE = `Domain: google.de
Status: connect
`;

/** whois.nic.ch. A refusal, delivered as ordinary body text with no status code of any kind. */
const CH = `Requests of this client are not permitted. Please use https://www.nic.ch/whois/ for queries.
`;

/** whois.nic.io. The ICANN-style format, with EPP codes trailed by their reference URL. */
const IO = `Domain Name: google.io
Registry Domain ID: REDACTED
Registrar WHOIS Server: whois.markmonitor.com
Registrar URL: http://www.markmonitor.com
Updated Date: 2026-08-12T07:41:13Z
Creation Date: 2002-10-01T01:00:00Z
Registry Expiry Date: 2026-09-30T01:00:00Z
Registrar: MarkMonitor Inc.
Registrar IANA ID: 292
Domain Status: clientDeleteProhibited https://icann.org/epp#clientDeleteProhibited
Domain Status: serverHold https://icann.org/epp#serverHold
Name Server: ns1.google.com
Name Server: NS2.GOOGLE.COM.
DNSSEC: unsigned
>>> Last update of WHOIS database: 2026-08-12T17:47:26Z <<<
`;

/** whois.sk-nic.sk. Statuses arrive comma-separated on a single line. */
const SK = `Domain:                       google.sk
Created:                      2003-07-24
Valid Until:                  2027-07-24
Updated:                      2026-06-22
Domain Status:                clientTransferProhibited, pendingDelete
Nameserver:                   ns1.google.com
`;

/** whois.iis.se. Lowercase labels, repeated status lines, and a `transferred` date that is not creation. */
const SE = `# Copyright (c) 1997- The Swedish Internet Foundation.
#
state:            active
domain:           google.se
created:          2003-08-27
modified:         2025-09-18
expires:          2026-10-20
transferred:      2009-03-06
nserver:          ns1.google.com
status:           serverUpdateProhibited
status:           serverDeleteProhibited
registrar:        MarkMonitor Inc
`;

/** whois.jprs.jp. Bracketed labels, a bracketed banner, and slash-separated dates. */
const JP = `[ JPRS database provides information on network administration. Its use is    ]
[ restricted to network administration purposes.                               ]
Domain Information: [ドメイン情報]
[Domain Name]                   GOOGLE.JP

[Name Server]                   ns1.google.com

[登録年月日]                    2005/05/30
[有効期限]                      2027/05/31
[最終更新]                      2026/06/01
`;

/** whois.kr. Korean labels and a dotted date with spaces inside it. */
const KR = `query : google.kr

도메인이름                  : google.kr
등록인                      : 구글코리아유한회사
등록일                      : 2007. 03. 02.
최근 정보 변경일            : 2026. 04. 15.
사용 종료일                 : 2027. 03. 02.
`;

function record(body: string) {
  const parsed = parseWhois(body);
  if (parsed.kind !== 'record') throw new Error(`expected a record, got ${parsed.kind}`);
  return parsed.facts;
}

describe('whois parser', () => {
  it('reads the domain record rather than a contact record when a label repeats', () => {
    // The trap this exists for: `.it` repeats `Created:` inside every contact block. Taking the last
    // value reports 2026 for a domain registered in 1999, which is a twenty-six year error in the
    // heaviest-weighted signal in the model, delivered with full confidence.
    expect(record(IT).creation).toBe('1999-12-10T00:00:00Z');
    expect(record(IT).expiry).toBe('2027-04-21T00:00:00Z');
    expect(record(IT).lastChanged).toBe('2026-06-09T23:13:34Z');
    expect(record(IT).registrantOrg).toBe('Google Ireland Holdings Unlimited Company');
  });

  it('does not read `NOT AVAILABLE` as availability', () => {
    // A substring test for "available" would report every registered `.be` domain as unregistered.
    const facts = record(BE);
    expect(facts.creation).toBe('2000-12-12T00:00:00Z');
  });

  it.each([
    ['nic.it', 'Domain: x.it\nStatus:             AVAILABLE\n'],
    ['eurid', 'Domain: x.eu\nScript: LATIN\nStatus: AVAILABLE\n'],
    ['denic', 'Domain: x.de\nStatus: free\n'],
    ['a no-match line', 'No match for "x.example".\n'],
    ['a not-found line', '%% NOT FOUND\n'],
  ])('reports an unregistered name from %s', (_label, body) => {
    expect(parseWhois(body).kind).toBe('unregistered');
  });

  it('separates a refusal from an empty record', () => {
    // Without this the throttled response parses as a registration containing no fields, and a rate
    // limit becomes indistinguishable from a registry that publishes nothing.
    expect(parseWhois(CH).kind).toBe('refused');
  });

  it('answers with no creation date where the registry publishes none', () => {
    const facts = record(DE);
    expect(facts.creation).toBeUndefined();
    expect(facts.statuses).toContain('connect');
  });

  it('normalises EPP codes to the same vocabulary the RDAP collector produces', () => {
    // Trailed by a reference URL at `.io`, comma-separated at `.sk`, one per line at `.se`. The status
    // signals match on exact lowercased codes, so all three have to arrive in that form.
    expect(record(IO).statuses).toContain('serverhold');
    expect(record(IO).statuses).toContain('clientdeleteprohibited');
    expect(record(SK).statuses).toContain('pendingdelete');
    expect(record(SE).statuses).toEqual(
      expect.arrayContaining(['serverupdateprohibited', 'serverdeleteprohibited']),
    );
  });

  it('reads the registrar and its IANA id where the registry publishes them', () => {
    const facts = record(IO);
    expect(facts.registrar).toBe('MarkMonitor Inc.');
    expect(facts.registrarIanaId).toBe('292');
    // `Registrar WHOIS Server` and `Registrar URL` must not be mistaken for the registrar itself.
    expect(facts.registrar).not.toContain('whois');
  });

  it('normalises nameservers the way the RDAP collector does', () => {
    expect(record(IO).nameservers).toEqual(['ns1.google.com', 'ns2.google.com']);
  });

  it('ignores a transfer date, which is not a creation date', () => {
    expect(record(SE).creation).toBe('2003-08-27T00:00:00Z');
  });

  it('reads bracketed labels and skips the banner written in the same shape', () => {
    const facts = record(JP);
    expect(facts.creation).toBe('2005-05-30T00:00:00Z');
    expect(facts.expiry).toBe('2027-05-31T00:00:00Z');
  });

  it('reads a dotted date with spaces inside it', () => {
    expect(record(KR).creation).toBe('2007-03-02T00:00:00Z');
  });

  it('marks the record with the protocol that produced it', () => {
    expect(record(IT).via).toBe('whois');
  });
});

describe('whois date normalisation', () => {
  it.each([
    ['2002-10-01T01:00:00Z', '2002-10-01T01:00:00Z'],
    ['1999-12-10 00:00:00', '1999-12-10T00:00:00Z'],
    ['2003-08-27', '2003-08-27T00:00:00Z'],
    ['2005/05/30', '2005-05-30T00:00:00Z'],
    ['2007. 03. 02.', '2007-03-02T00:00:00Z'],
    ['20241113 19:36:02', '2024-11-13T19:36:02Z'],
    ['Tue Dec 12 2000', '2000-12-12T00:00:00Z'],
    ['2026/06/01 01:05:03 (JST)', undefined],
  ])('reads %s', (input, expected) => {
    expect(parseWhoisDate(input)).toBe(expected);
  });

  /**
   * The reason this is a fixed vocabulary rather than a call to `Date.parse`.
   *
   * `Date.parse` accepts all of these and resolves the ambiguity by guessing. A wrong date is worse than
   * no date here, because the age dimension carries the heaviest weight in the model and nothing
   * downstream can tell an inferred date from a published one.
   */
  it.each([['01-02-2020'], ['12/31/99'], ['3 Jun 21'], ['before 2000'], [''], ['unknown']])(
    'refuses the ambiguous or unparseable %s',
    (input) => {
      expect(parseWhoisDate(input)).toBeUndefined();
    },
  );
});

describe('whois server map', () => {
  it('covers the widely used commercial suffixes that publish no RDAP', () => {
    expect(findWhoisServer('it')).toBe('whois.nic.it');
    expect(findWhoisServer('de')).toBe('whois.denic.de');
    expect(findWhoisServer('se')).toBe('whois.iis.se');
    expect(findWhoisServer('jp')).toBe('whois.jprs.jp');
  });

  it('answers a second-level suffix from its registry, which runs one service for the namespace', () => {
    // Unlike suffix pricing, inheriting the parent is correct rather than a guess: a registry operates
    // one WHOIS service for its whole namespace, so there is no second-level service to miss.
    expect(findWhoisServer('co.jp')).toBe('whois.jprs.jp');
    expect(findWhoisServer('gv.at')).toBe('whois.nic.at');
  });

  /**
   * The map deliberately covers suffixes that publish RDAP as well, which is the entry the fallback
   * needs and the reason it was previously impossible.
   *
   * `.id` is the case that forced it: its registry publishes RDAP and rate limits by dropping the
   * connection, so every domain under it stalled to a `timeout` and yielded no age. Nothing here says
   * WHOIS should be preferred — `analyze` reaches for it only once RDAP has failed to answer.
   */
  it('carries an entry for a suffix that publishes RDAP, so a stalled server has a fallback', () => {
    expect(findWhoisServer('id')).toBe('whois.id');
    expect(findWhoisServer('web.id')).toBe('whois.id');
    expect(findWhoisServer('com')).toBe('whois.verisign-grs.com');
  });

  it('carries no entry for a suffix that publishes neither', () => {
    expect(findWhoisServer('za')).toBeNull();
  });
});

describe('whois collector', () => {
  it('reports an unsupported suffix without opening a socket', async () => {
    // `.za` publishes no RDAP and no port-43 server, so this is the honest end of the line rather than
    // a failure. It must cost no network time to establish that.
    await expect(collectWhois('example.co.za', 'co.za', 1_000)).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('registration periods', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  it('derives a term only inside the first registration period', () => {
    // Shared with the RDAP collector precisely so a `.it` domain and a `.com` one cannot end up scored
    // on different arithmetic.
    expect(derivePeriods('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', now).termYears).toBe(1);
    expect(derivePeriods('2003-08-27T00:00:00Z', '2027-08-27T00:00:00Z', now).termYears).toBeUndefined();
  });

  it('measures remaining term from now rather than from creation', () => {
    expect(derivePeriods('1999-12-10T00:00:00Z', '2027-06-01T00:00:00Z', now).yearsUntilExpiry).toBe(1);
  });
});

describe('whois budget', () => {
  it('fits inside the wave it shares with the site probe', () => {
    // It rides in the second wave, so giving it more than the longest source there would widen the
    // whole sequence and eat the global deadline's slack.
    expect(BUDGET.whoisMs).toBeLessThanOrEqual(BUDGET.siteMs);
  });
});
