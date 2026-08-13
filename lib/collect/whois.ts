import { createConnection } from 'node:net';
import { BUDGET } from '../budget';
import { RateLimitedError, TimeoutError, UnsupportedError } from '../errors';
import { capture } from '../record';
import { findWhoisServer } from '../data/whois-servers';
import { buildRegistrationFacts } from './registration';
import type { RegistrationFacts } from '../facts';

/**
 * WHOIS on port 43: the age anchor wherever RDAP produced no answer.
 *
 * RDAP is the better source in every respect and is always preferred where it responds. This runs only
 * when it did not: either the suffix publishes no RDAP service, or the server exists and never answered.
 *
 * That second trigger was originally excluded, on the reasoning that a failed request is not a missing
 * protocol and a retry would re-ask a settled question over the slowest transport in the system. The
 * holdout contradicted it. 14% of domains were getting no registration record because their registry
 * rate limits by dropping the connection instead of returning a status — so the question had no answer,
 * every domain under that registry failed identically, and no `rate_limited` status ever appeared to say
 * so. Port 43 answered those same domains in a few hundred milliseconds, with creation dates matching
 * what RDAP returned once it was willing to talk again.
 *
 * What it buys: of the 1438 root-zone suffixes, 872 answer here. That covers the 238 with no RDAP at all,
 * among them several of the most widely used commercial namespaces in Europe and Asia, and it now also
 * covers the registries that publish RDAP and periodically refuse to serve it. Both cases previously
 * scored with no age evidence, which is the single heaviest input to the model.
 *
 * What it does not buy, and must not pretend to: a good number of these registries answer without
 * publishing a creation date at all. DENIC returns a status line and nothing else; `.at` and `.eu`
 * publish contact and nameserver data but no registration date. Those come back as an answered source
 * carrying no age, which is exactly what happened before and is reported plainly rather than filled in.
 *
 * There is deliberately no referral hop to the registrar's own WHOIS server. It would add a second TCP
 * connection on the slowest transport in the system, and the registries reached here answer the creation
 * date directly, which is the only field the model reads that a referral would improve.
 */

const WHOIS_PORT = 43;

/**
 * One port-43 query.
 *
 * The protocol is a single line in, a stream out, connection closed by the server. There is no status
 * code, no content type and no framing: the only signal that a response is complete is the socket
 * ending, which is why a stalled server has to be timed out rather than detected.
 *
 * Routed through `capture` for the same reason every HTTP call is, so a calibration run can be re-parsed
 * offline. This is the one exit to the network that is not HTTP, and leaving it unrecorded would mean a
 * stored run silently lost the age signal for every ccTLD in it the moment the parser changed.
 */
async function query(server: string, term: string, timeoutMs: number): Promise<string> {
  return capture(
    { call: 'whois', url: `whois://${server}/${term}` },
    { encode: (body) => ({ body }), decode: (exchange) => exchange.body ?? '' },
    () =>
      new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const socket = createConnection({ host: server, port: WHOIS_PORT });

        const fail = (error: Error) => {
          socket.destroy();
          reject(error);
        };

        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => fail(new TimeoutError(timeoutMs)));
        socket.on('error', fail);
        socket.on('connect', () => socket.write(`${term}\r\n`));

        socket.on('data', (chunk: Buffer) => {
          // The same cap the HTTP layer applies, and needed here for the same reason: the response ends
          // when the server closes the socket, so a hostile or broken one can otherwise stream until the
          // function dies. Every real record is a few kilobytes, so this truncates nothing genuine.
          if (total >= BUDGET.maxBodyBytes) return;
          total += chunk.byteLength;
          chunks.push(chunk);
        });

        socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }),
  );
}

/**
 * Phrases a registry uses to say the name is not registered.
 *
 * Matched against a whole line or a whole field value, never as a substring of the body. `.be` reports a
 * *registered* domain as `Status: NOT AVAILABLE`, so a substring test for "available" inverts the answer
 * on an entire ccTLD.
 */
const UNREGISTERED_VALUES = new Set([
  'available',
  'free',
  'no object found',
  'not registered',
  'available for registration',
]);

/**
 * The leading `[%#]*` is not decoration. Several registries write the no-match line as a comment —
 * `%% NOT FOUND` and `%ERROR:101: no entries found` are both live formats — and an anchor that did not
 * allow the marker would read those responses as a registration with no fields in it.
 */
const UNREGISTERED_LINES =
  /^[\s%#]*(no match|not found|nothing found|no entries found|no data found|no information available|domain not found|the queried object does not exist|this domain name has not been registered)/im;

/**
 * Access refusals, which are the opposite of an empty answer and must never be read as one.
 *
 * Port 43 is rate limited far more aggressively than RDAP and the limits are per source address, which on
 * a serverless platform is an address shared with everyone else on it. A refusal arrives as ordinary body
 * text with no status code, so without this it would parse as a record containing no fields, and a
 * throttled lookup would be indistinguishable from a registry that publishes nothing.
 */
const REFUSAL_PATTERNS = [
  /requests? of this client are not permitted/i,
  /rate.?limit/i,
  /too many requests/i,
  /query(?: rate)? limit exceeded/i,
  /exceeded .{0,40}(quota|limit)/i,
  /quota exceeded/i,
  /access denied/i,
  /connection refused by/i,
  /you have been blocked/i,
  /try again later/i,
  /service temporarily unavailable/i,
];

/**
 * Field labels, normalised to lowercase with runs of whitespace collapsed.
 *
 * This is a fixed vocabulary rather than a heuristic, and it is the reason the parser can be trusted: a
 * label it does not know yields no value, so a format it has never seen produces missing evidence instead
 * of a wrong date. Every entry was read off a live response from the registry that uses it.
 */
const CREATED_KEYS = new Set([
  'created',
  'created on',
  'created date',
  'creation date',
  'domain created',
  'domain create date',
  'record created',
  'registered',
  'registered on',
  'registered date',
  'registration date',
  'registration time',
  'domain registration date',
  'first registration date',
  'activated',
  // JPRS and KISA label their records in the local language on the primary line.
  '登録年月日',
  '등록일',
]);

const EXPIRY_KEYS = new Set([
  'expiry date',
  'expire date',
  'expires',
  'expires on',
  'expiration date',
  'expiration time',
  'registry expiry date',
  'domain expiration date',
  'valid until',
  'renewal date',
  'paid-till',
  '有効期限',
  '사용 종료일',
]);

const UPDATED_KEYS = new Set([
  'updated',
  'updated date',
  'last update',
  'last updated',
  'last modified',
  'modified',
  'changed',
]);

const STATUS_KEYS = new Set(['status', 'domain status', 'state', 'eppstatus']);
const NAMESERVER_KEYS = new Set(['nserver', 'name server', 'nameserver', 'name servers', 'host name']);
const REGISTRAR_KEYS = new Set(['registrar', 'sponsoring registrar', 'registrar name']);
const REGISTRANT_ORG_KEYS = new Set([
  'registrant organization',
  'registrant organisation',
  'organization',
  'organisation',
  'org',
  'holder',
]);

type Fields = {
  /** First value seen for each key. */
  first: Map<string, string>;
  /** Every value seen, for the repeating keys. */
  all: Map<string, string[]>;
};

/**
 * Splits a response into labelled fields.
 *
 * First occurrence wins for the single-valued keys, and that rule is load-bearing rather than arbitrary.
 * The `.it` registry repeats `Created:` inside each contact block, so a parser taking the last value
 * reports the date the administrative contact record was touched — for a domain registered in 1999 and
 * updated this year, that is a twenty-six-year error in the one signal the model weighs most heavily.
 */
function parseFields(body: string): Fields {
  const first = new Map<string, string>();
  const all = new Map<string, string[]>();

  for (const raw of body.split(/\r?\n/)) {
    // Comment and banner conventions differ per registry: `%` at EURid and nic.at, `#` at IIS, a
    // bracketed banner at JPRS, and a `>>>` footer in the ICANN-style responses.
    if (/^\s*[%#]/.test(raw) || /^\s*>>>/.test(raw) || /^\s*\[\s/.test(raw)) continue;

    // JPRS writes `[Label]  value` rather than `Label: value`. Its banner lines are the same shape with
    // a space after the bracket, which is why they are dropped above before this runs.
    const bracketed = /^\[([^\]\s][^\]]*)\]\s*(.*)$/.exec(raw);
    const [key, value] = bracketed
      ? [bracketed[1], bracketed[2]]
      : (() => {
          const at = raw.indexOf(':');
          return at === -1 ? ['', ''] : [raw.slice(0, at), raw.slice(at + 1)];
        })();

    const name = key.trim().toLowerCase().replace(/\s+/g, ' ');
    const text = value.trim();
    if (!name || !text) continue;

    if (!first.has(name)) first.set(name, text);
    const existing = all.get(name);
    if (existing) existing.push(text);
    else all.set(name, [text]);
  }

  return { first, all };
}

function firstOf(fields: Fields, keys: Set<string>): string | undefined {
  for (const [name, value] of fields.first) {
    if (keys.has(name)) return value;
  }
  return undefined;
}

function allOf(fields: Fields, keys: Set<string>): string[] {
  const values: string[] = [];
  for (const [name, entries] of fields.all) {
    if (keys.has(name)) values.push(...entries);
  }
  return values;
}

/**
 * Normalises the date formats the registries actually emit, and returns nothing for anything else.
 *
 * Deliberately not `Date.parse` on the raw string. That accepts far more than these registries produce
 * and resolves ambiguity by guessing: `01-02-2020` parses happily and means opposite things in the two
 * hemispheres, and a wrong date here is worse than no date, because the age dimension would score it with
 * full weight and no indication that anything was inferred. Only unambiguous forms are accepted.
 */
export function parseWhoisDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();

  // Trailing timezone annotations that the numeric forms below carry at some registries, e.g. `(JST)`.
  const cleaned = text.replace(/\s*\([A-Z]{2,5}\)\s*$/, '').trim();

  const patterns: { re: RegExp; iso: (m: RegExpExecArray) => string }[] = [
    // 2002-10-01T01:00:00Z and 1999-12-10 00:00:00
    {
      re: /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/,
      iso: (m) => `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,
    },
    // 2003-08-27
    { re: /^(\d{4})-(\d{2})-(\d{2})$/, iso: (m) => `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` },
    // 2005/05/30
    { re: /^(\d{4})\/(\d{2})\/(\d{2})$/, iso: (m) => `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` },
    // 2007. 03. 02.  (KISA)
    { re: /^(\d{4})\.\s*(\d{2})\.\s*(\d{2})\.?$/, iso: (m) => `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` },
    // 20241113 19:36:02  (nic.at)
    {
      re: /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
      iso: (m) => `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,
    },
    // Tue Dec 12 2000  (DNS Belgium)
    {
      re: /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/,
      iso: (m) => {
        const month = MONTHS.indexOf(m[1].toLowerCase());
        if (month === -1) return '';
        return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}T00:00:00Z`;
      },
    },
  ];

  for (const { re, iso } of patterns) {
    const match = re.exec(cleaned);
    if (!match) continue;
    const candidate = iso(match);
    if (candidate && Number.isFinite(Date.parse(candidate))) return candidate;
  }

  return undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export type WhoisParse =
  | { kind: 'record'; facts: RegistrationFacts }
  | { kind: 'unregistered' }
  | { kind: 'refused'; message: string };

/** Pure, so the whole parser is testable against stored responses with no socket involved. */
export function parseWhois(body: string, now: number = Date.now()): WhoisParse {
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(body)) {
      return { kind: 'refused', message: 'The registry refused the query, usually a per-address rate limit' };
    }
  }

  const fields = parseFields(body);

  const statusValues = allOf(fields, STATUS_KEYS);
  if (statusValues.some((value) => UNREGISTERED_VALUES.has(value.trim().toLowerCase()))) {
    return { kind: 'unregistered' };
  }
  if (UNREGISTERED_LINES.test(body)) {
    return { kind: 'unregistered' };
  }

  const creation = parseWhoisDate(firstOf(fields, CREATED_KEYS));
  const expiry = parseWhoisDate(firstOf(fields, EXPIRY_KEYS));
  const lastChanged = parseWhoisDate(firstOf(fields, UPDATED_KEYS));
  const registrantOrg = firstOf(fields, REGISTRANT_ORG_KEYS);

  /**
   * EPP codes arrive three ways: bare, followed by the ICANN reference URL, or comma-separated on one
   * line. All three normalise to the same lowercased tokens the RDAP collector produces, so the status
   * signals read one vocabulary regardless of which source answered.
   */
  const statuses = statusValues
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().split(/\s+/)[0]?.toLowerCase().replace(/\s+/g, ''))
    .filter((value): value is string => Boolean(value));

  return {
    kind: 'record',
    facts: buildRegistrationFacts(
      {
        via: 'whois',
        creation,
        expiry,
        lastChanged,
        statuses,
        registrar: firstOf(fields, REGISTRAR_KEYS),
        registrarIanaId: fields.first.get('registrar iana id'),
        registrantOrg,
        // Registries pad the nameserver line with the glue address, so only the first token is a name.
        nameservers: allOf(fields, NAMESERVER_KEYS).map((value) => value.trim().split(/\s+/)[0]),
      },
      now,
    ),
  };
}

export type WhoisResult = {
  facts: RegistrationFacts;
  sourceUrl: string;
  /** Shown against the source even on success, for the registries that answer without a creation date. */
  notice?: string;
};

export async function collectWhois(
  domain: string,
  suffix: string,
  timeoutMs: number,
): Promise<WhoisResult> {
  const server = findWhoisServer(suffix);

  if (!server) {
    throw new UnsupportedError(
      `The .${suffix} registry publishes neither an RDAP service nor a WHOIS server, so this domain's age is unknown`,
    );
  }

  const body = await query(server, domain, timeoutMs);

  // A server that accepts the connection and closes without saying anything is broken, not a registry
  // publishing nothing. Reporting it as an answered source carrying no fields would put a transport
  // failure on the same footing as DENIC's deliberate silence, and only one of those is worth telling
  // the reader about.
  if (!body.trim()) {
    throw new Error(`${server} closed the connection without sending a record`);
  }

  const parsed = parseWhois(body);

  if (parsed.kind === 'refused') {
    throw new RateLimitedError(`${parsed.message} at ${server}`);
  }

  if (parsed.kind === 'unregistered') {
    throw new UnsupportedError(
      `The .${suffix} registry reports no registration for this domain, so there is no record to read`,
    );
  }

  return {
    facts: parsed.facts,
    sourceUrl: `whois://${server}/${domain}`,
    notice: parsed.facts.creation
      ? undefined
      : `${server} answered but publishes no registration date, so this domain has no age evidence`,
  };
}
