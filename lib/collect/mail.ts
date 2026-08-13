import { txtAt, txtAtFollowingCname } from './dns';
import { splitBudget } from '../budget';
import { fetchText } from '../fetch';
import { parseBimiRecord, verifyVmc } from '../bimi-vmc';
import {
  COMMERCIAL_DMARC_VENDORS,
  PAID_SPF_SENDERS,
  countSaasVendors,
  matchDisposableVerification,
} from '../data/saas-verification-vendors';
import type { DnsFacts, MailFacts } from '../facts';
import { classifyDkimProvider } from '../data/dns-services';

/**
 * Mail posture, weighted on what a third party had to agree to.
 *
 * Everything in a mail policy is a string the domain publishes about itself, so depth of configuration
 * turned out to measure nothing an operator could not type in a minute. Strict alignment, an explicit
 * subdomain policy and a named sending platform were all read as evidence of investment and all cost
 * nothing whatsoever to assert. They are still collected, because they ride along in a record already
 * being fetched and a reader wants to see them, and they no longer score. See `docs/SCORING.md`.
 *
 * BIMI is the exception that had a query of its own, lost it in 1.3.0 with its credit, and got it back
 * in 1.6.0 on different terms: the certificate is now fetched and verified rather than the record being
 * taken at its word, and the lookup only happens behind the enforcing DMARC policy the BIMI
 * specification requires. It still scores nothing, for want of a population publishing enough of it to
 * price. See `collectBimi` below.
 *
 * One part survives as evidence: the reporting vendor, because RFC 7489 §7.1 makes an external report
 * destination authorise the domain in its own zone, and only the vendor can publish that.
 *
 * The only negatives here are affirmative misconfigurations. Absence is silence, because a legitimate
 * small business commonly has none of this.
 */

/**
 * DKIM selectors worth probing. There is no way to enumerate selectors from DNS, so this is a fixed set
 * of the defaults used by the major mail platforms. Finding none proves nothing, which is why absence
 * carries no penalty.
 *
 * The list is bounded by marginal coverage rather than by how many selectors exist, because each entry
 * costs a DNS query on every analysis while `footprint.dkim` reads only whether any key was found. A
 * second selector matching a domain the first already matched therefore changes nothing. Measured over
 * 4,691 holdout domains, 423 of which publish a key, these six reach 98.8% of all detections.
 * `selector2` and `k1` were dropped: Microsoft publishes `selector1` beside `selector2`, so the latter
 * uniquely covered one domain, and `k1` covered four.
 *
 * These are the last dedicated queries in the collector, and unlike the BIMI and business-service probes
 * 1.3.0 deleted, they are not paid for a fact nothing weighs. `footprint.dkim` scores zero, but
 * `combo.inbound_without_outbound` reads the *absence* of a key as one third of a -10 conjunction, so a
 * selector that goes unprobed is a penalty applied to a domain that did not earn it. Presence is free to
 * assert and worth nothing; absence, paired with no SPF and no DMARC, is the finding.
 */
const DKIM_SELECTORS = ['default', 'google', 's1', 'dkim', 'mail', 'selector1'];

export async function collectMail(
  domain: string,
  dns: DnsFacts | undefined,
  timeoutMs: number,
): Promise<MailFacts> {
  const per = splitBudget(timeoutMs, 2);
  const apexTxt = dns?.txt ?? [];

  const [dmarcRecords, dkimKeys] = await Promise.all([
    txtAt(`_dmarc.${domain}`, per).catch(() => [] as string[]),
    probeDkimSelectors(domain, per),
  ]);

  const spf = apexTxt.find((record) => record.toLowerCase().startsWith('v=spf1'));
  const dmarc = dmarcRecords.find((record) => record.toLowerCase().startsWith('v=dmarc1'));

  const spfIncludes = spf
    ? [...spf.matchAll(/include:([^\s]+)/gi)].map((match) => match[1].toLowerCase())
    : [];

  const dmarcTags = parseTags(dmarc);
  const rua = (dmarcTags.rua ?? '')
    .split(',')
    .map((value) => value.trim().replace(/^mailto:/i, ''))
    .filter(Boolean);

  const commercialVendor = COMMERCIAL_DMARC_VENDORS.find((vendor) =>
    rua.some((address) => address.toLowerCase().includes(vendor)),
  );
  const dmarcPolicy = normalisePolicy(dmarcTags.p);
  const [ruaVerified, bimi] = await Promise.all([
    verifyReportingVendor(domain, rua, commercialVendor, per),
    collectBimi(domain, dmarcPolicy, per),
  ]);

  return {
    spf,
    spfAllQualifier: spfAllQualifier(spf),
    spfIncludes,
    spfPaidSenders: [
      ...new Set(
        PAID_SPF_SENDERS.filter(({ pattern }) =>
          spfIncludes.some((include) => include.endsWith(pattern)),
        ).map(({ vendor }) => vendor),
      ),
    ],
    dmarc,
    dmarcPolicy,
    dmarcSubdomainPolicy: dmarcTags.sp,
    dmarcStrictAlignment: dmarcTags.aspf === 's' || dmarcTags.adkim === 's',
    dmarcRua: rua,
    dmarcRuaCommercialVendor: commercialVendor,
    dmarcRuaVerified: ruaVerified,
    dkimSelectors: dkimKeys.map(({ selector }) => selector),
    dkimKeys,
    saasVendors: countSaasVendors(apexTxt),
    // Read out of the same already-fetched record set as the line above, so this costs no query.
    disposableVerification: matchDisposableVerification(apexTxt),
    bimi,
  };
}

/**
 * BIMI, checked to the certificate rather than to the record.
 *
 * The 1.3.0 removal was right about the old signal and wrong about the fact. `mail.bimi` paid +8 for a
 * TXT record beginning with `v=BIMI1`, which is a string anyone can publish, and it never fetched the
 * Verified Mark Certificate the record points at. That certificate is the whole of what makes BIMI
 * interesting: it requires a registered trademark, proof of control over it, and roughly a thousand
 * dollars a year, none of which is inherited by publishing a pointer to nothing.
 *
 * **Gating on an enforcing DMARC policy is the specification, not an optimisation.** A BIMI record has
 * no effect without `p=quarantine` or `p=reject`, so a record published under `p=none` is inert and the
 * lookup would be asking about something that cannot be in force. The cost follows from that: measured
 * over the holdout the gate opens on 5.5% of analyses — 3.8% of abuse domains against 37.7% of
 * legitimate ones — so this is one TXT query on roughly one analysis in eighteen, and the certificate
 * fetch behind it happens on about one in nine hundred.
 *
 * The credit is nevertheless zero, and the census in `scripts/bimi-census.mts` is why: 5 records across
 * 4,698 domains, one of which pointed at a certificate. See `lib/scoring/weights.ts`.
 *
 * **Keeping the query while the weight is zero is a deliberate exception to the rule that retired the
 * `robots.txt` probe and the business-service names**, and it should be argued rather than assumed. That
 * rule is that a round trip must be paid for by a fact that can move a verdict. Three things pay for
 * this one instead. The gate makes it nearly free — 5.5% of analyses, and a certificate fetch on about
 * one in nine hundred. The reported observation is itself the return: a domain asking mailbox providers
 * to display its logo on the strength of a certificate that expired, or was issued to somebody else, is
 * worth telling a reader about even though the model declines to price it. And the zero here is a
 * statement about this holdout rather than about the signal, so a query that keeps producing the fact is
 * what allows a future population to price it, where deleting it would guarantee the question stays
 * unanswerable.
 *
 * The corollary is that the failure must be legible. `failureDetail` carries the specific finding for
 * exactly that reason: an unexplained rejection reads as the checker being broken.
 */
async function collectBimi(
  domain: string,
  policy: string | undefined,
  timeoutMs: number,
): Promise<MailFacts['bimi']> {
  if (policy !== 'quarantine' && policy !== 'reject') return undefined;

  let records: string[];
  try {
    records = await txtAt(`default._bimi.${domain}`, timeoutMs);
  } catch {
    // The resolver did not answer, so nothing was established. Reporting that as "no record" would let
    // a timeout read as a domain declining to publish one.
    return undefined;
  }

  const parsed = records.map((record) => parseBimiRecord(record)).find(Boolean);
  if (!parsed) return undefined;

  if (!parsed.certificateUrl) {
    return { record: true, verified: false, failure: 'no_certificate' };
  }

  let pem: string;
  try {
    pem = await fetchText(parsed.certificateUrl, { timeoutMs });
  } catch {
    return {
      record: true,
      certificateUrl: parsed.certificateUrl,
      verified: false,
      failure: 'unreachable',
    };
  }

  const result = verifyVmc(pem, domain);
  return {
    record: true,
    certificateUrl: parsed.certificateUrl,
    verified: result.verified,
    issuer: result.issuer,
    markHolder: result.subject,
    failure: result.failure,
    // The specific half of the answer: which certificate lapsed, whose domain it was really for. A
    // reader shown only that verification failed has been told to take it on trust.
    failureDetail: result.detail,
  };
}

/**
 * Confirms a named reporting vendor actually knows about this domain.
 *
 * Naming a vendor in `rua` is free: the tag is a string the domain publishes about itself, and nothing
 * in it requires an account with the party named. RFC 7489 §7.1 supplies the missing half. Sending
 * reports to a destination outside the domain's own namespace requires that destination to authorise
 * it, by publishing a DMARC record at `<domain>._report._dmarc.<destination>`, and only the vendor can
 * create that record. It is therefore the one part of a DMARC policy that a third party has to agree
 * to, which is why it is the only part of mail posture the model still scores.
 *
 * The query runs only when a commercial vendor was matched, so the overwhelming majority of domains
 * cost nothing extra. It has to follow the DMARC lookup rather than run beside it, since the
 * destination is not known until the record is parsed.
 */
async function verifyReportingVendor(
  domain: string,
  rua: readonly string[],
  vendor: string | undefined,
  timeoutMs: number,
): Promise<boolean | undefined> {
  if (!vendor) return undefined;

  const address = rua.find((entry) => entry.toLowerCase().includes(vendor));
  const destination = address ? reportDestination(address) : undefined;
  if (!destination) return undefined;

  // An in-namespace destination needs no authorisation under the RFC, so there is nothing to check
  // rather than a check that failed.
  if (destination === domain || destination.endsWith(`.${domain}`)) return undefined;

  try {
    const records = await txtAt(`${domain}._report._dmarc.${destination}`, timeoutMs);
    return records.some((record) => record.toLowerCase().startsWith('v=dmarc1'));
  } catch {
    // The resolver did not answer, so this check has no result either way. Reporting that as a refusal
    // would let a timeout look like a vendor declining to vouch for the domain.
    return undefined;
  }
}

/** The domain half of an `rua` address, less the optional `!size` limit the grammar allows. */
function reportDestination(address: string): string | undefined {
  const host = address.split('@').at(-1)?.split('!')[0]?.trim().replace(/\.$/, '').toLowerCase();
  return host && host.includes('.') ? host : undefined;
}

async function probeDkimSelectors(
  domain: string,
  timeoutMs: number,
): Promise<MailFacts['dkimKeys']> {
  const results = await Promise.all(
    DKIM_SELECTORS.map(async (selector) => {
      try {
        const { records, cnameTarget } = await txtAtFollowingCname(
          `${selector}._domainkey.${domain}`,
          timeoutMs,
        );
        if (!records.some(isDkimKeyRecord)) return null;
        return {
          selector,
          cnameTarget,
          provider: cnameTarget ? classifyDkimProvider(cnameTarget) : undefined,
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((key): key is NonNullable<typeof key> => key !== null);
}

/**
 * Whether a TXT record at a selector is actually a DKIM key.
 *
 * The previous test accepted any record containing the substring `p=`, anywhere and in any form, which
 * matched a great deal that is not a key: an SPF record's `ip4=` mechanism contains it, as does any
 * prose with the letter p before an equals sign. What is required instead is the RFC 6376 §3.6.1
 * grammar — a `p` tag carrying a non-empty value, and a `v` tag naming DKIM1 if it is present at all,
 * since the version tag is optional and defaults to DKIM1.
 *
 * An empty `p` is deliberately rejected: the RFC gives it the specific meaning that the key has been
 * revoked, so a selector publishing one is evidence of a key that no longer exists.
 *
 * This stops short of parsing the base64 into a public key, which would prove only that somebody ran a
 * key generator. That is free, and it is why `footprint.dkim` no longer scores; validating the key
 * material would add cost to a fact the model reads but does not weigh.
 */
function isDkimKeyRecord(record: string): boolean {
  const tags = parseTagList(record, { lowercaseValues: false });

  const version = tags.v;
  if (version !== undefined && version.toLowerCase() !== 'dkim1') return false;
  return (tags.p ?? '').length > 0;
}

/**
 * The `key=value;` grammar shared by the DMARC and DKIM record formats.
 *
 * `lowercaseValues` is the whole reason this takes an option rather than being one function. DMARC
 * tag values are keywords and every reader here compares them lowercased, while a DKIM `p` tag is
 * base64 key material where case is significant — folding it would corrupt the one field the record
 * exists to carry. The two parsers were written separately and differed in exactly this way by
 * accident of who wrote them first, which is a difference worth stating rather than rediscovering.
 */
function parseTagList(
  record: string | undefined,
  { lowercaseValues }: { lowercaseValues: boolean },
): Record<string, string> {
  if (!record) return {};
  const tags: Record<string, string> = {};
  for (const part of record.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const value = part.slice(index + 1).trim();
    tags[part.slice(0, index).trim().toLowerCase()] = lowercaseValues ? value.toLowerCase() : value;
  }
  return tags;
}

/** Parses the `key=value;` grammar a DMARC record uses, where every value is a keyword. */
function parseTags(record: string | undefined): Record<string, string> {
  return parseTagList(record, { lowercaseValues: true });
}

function normalisePolicy(value: string | undefined): MailFacts['dmarcPolicy'] {
  if (value === 'none' || value === 'quarantine' || value === 'reject') return value;
  return undefined;
}

/**
 * The final `all` mechanism is the one part of SPF that can be affirmatively wrong: `+all` authorises
 * the entire internet to send as this domain, which no competent operator publishes.
 */
function spfAllQualifier(spf: string | undefined): MailFacts['spfAllQualifier'] {
  if (!spf) return undefined;
  const match = spf.match(/([+~\-?])all\b/i);
  if (!match) return undefined;
  return `${match[1]}all` as MailFacts['spfAllQualifier'];
}
