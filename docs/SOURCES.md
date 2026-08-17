# Data sources

Every source is free and requires no registration, with one exception added in `1.4.0`: the Check-Mail
reputation lookup takes an API key and is metered. It is optional in the strict sense — with no key
configured it reports `unsupported` and nothing else changes — so a fresh clone still runs every other
source with no account anywhere. Each source was verified live during design; the observed behaviour is
recorded so a future failure can be told apart from a mistaken assumption.

Service endpoints appear below because they are operational facts about the system. No analysed domain
appears anywhere in this repository.

**Analysed domains do leave the system, and did not before `1.4.0`.** Every other source is either a
committed table or a query about a domain to infrastructure that already knows about it: a registry
asked about its own registration, a public resolver asked for a record it serves, the domain's own web
root. The reputation lookup is different in kind. It transmits the domain to a commercial vendor that
keeps it, and the vendor's homepage carries a public "recently checked domains" list whose relationship
to API traffic its documentation does not state. Anyone deploying this with a key should assume an
analysed domain may become publicly visible as having been analysed, and should confirm the current
position with the vendor if that matters. The local part of an email address is never sent — the model
discards it long before any collector runs — so what leaves is the domain and nothing else.

## In use

### RDAP — registration and age (the anchor)

- Bootstrap: `https://data.iana.org/rdap/dns.json`, roughly 1200 suffixes, cached in-process.
- The registry endpoint is then taken from the bootstrap and queried directly.
- Yields creation, expiry and `lastChanged` events, registrar and IANA ID, EPP status codes,
  nameservers and sometimes an unredacted registrant organisation.
- Use the bootstrap directly rather than a redirector service, which timed out at 15 s twice during
  testing.
- **238 of the root zone's 1438 suffixes publish no RDAP service at all**, including `.de`, `.it`,
  `.ch`, `.se`, `.eu`, `.jp`, `.at`, `.be`, `.ru` and `.kr`. Those degrade to `unsupported`.
- A registry that publishes RDAP can still fail to answer. Where it does, the port-43 collector below
  runs instead; see *When the registry publishes RDAP and does not answer*.

### WHOIS on port 43 — the registration record where RDAP does not answer

- Server per suffix from `lib/data/whois-servers.json`, a committed snapshot of IANA's own root database
  built by `npm run refresh:whois`. 872 of the root zone's 1438 suffixes publish a port-43 server and
  appear there; the other 565 publish none and stay `unsupported` where RDAP cannot answer either.
- **Runs when RDAP produced no answer**: either `unsupported`, meaning the protocol is absent, or
  `timeout` and `rate_limited`, meaning the server exists and did not respond. Not on `unavailable`,
  which is a registry that answered and said no — an answer, and one port 43 agrees with.
- RDAP remains preferred wherever it responds. This is a fallback, not a second opinion: no domain is
  scored from the text format while the structured one was available.
- Discovery is committed rather than performed per request. IANA's mapping is authoritative but reaching
  it costs a second port-43 round trip before the real query, to learn something that changes on the
  order of years.
- **No referral hop** to the registrar's own WHOIS server. Referrals are a gTLD pattern, and the thin
  registries that use them answer the creation date directly.
- Given a 3 s deadline rather than the standard 4 s. The protocol has no framing at all — a response ends
  when the socket does — so a stalled registry is indistinguishable from a slow one until the deadline
  fires. It shares its wave with the site probe, whose deadline is longer, so the attempt costs no
  wall-clock time on an analysis that makes it.

#### When the registry publishes RDAP and does not answer

The collector originally ran only on `unsupported`, on the reasoning that a failed request is not a
missing protocol and retrying it over the slowest transport in the system would re-ask a settled
question. Measuring the model against the labelled holdout showed both halves of that to be wrong.

**14% of domains got no registration record because RDAP stalled**, and they were not spread thinly: they
concentrated almost entirely on one registry, which serves roughly 20 requests and then blocks the client
address by dropping connections rather than returning a status. Every domain under it therefore stalls
identically until the deadline fires, and because no 429 is ever sent, `rate_limited` never appears and
the failure is indistinguishable from slowness. Queried on port 43, those same domains answer immediately
with a creation date.

That 14% is the slice attributable to a registry refusing this way, not the overall timeout rate.
`docs/CALIBRATION.md` reports 23% of domains timing out on RDAP, which is the wider figure: it counts
every registry that was merely slow as well as the ones deliberately dropping the connection.

So the question was not settled — it had no answer at all — and since age is the heaviest-weighted signal
in the model, this was the most expensive gap available to close.

**No published measurement covers the widened trigger yet.** Every figure in `docs/CALIBRATION.md` comes
from a collection made while this collector still ran on `unsupported` alone, so the 71% recovery rate it
quotes for port 43 is measured on the no-RDAP slice only, and the 23% it reports as RDAP timeouts is the
gap this change addresses rather than what is left after it. Pricing the change means collecting the
holdout again.

This is also why the server map covers suffixes that publish RDAP. Restricting it to the gap made the
fallback impossible by construction: the one transport that could still answer had no address to dial.

#### What it does and does not restore

Verified live against the registries named. `.it`, `.se`, `.jp` and `.io` return real creation dates and
the whole age dimension comes back with them. **`.de`, `.at` and `.eu` answer in full and publish no
registration date at all**, so those suffixes gain contact and status data but no age, which is reported
against the source rather than left as a blank the reader has to explain. `.ch` refuses automated queries
outright.

Two format traps are worth recording, because both produce a confidently wrong answer rather than a
missing one, and both are covered by tests:

- `.it` repeats `Created:` inside every contact block. A parser taking the last value reports the date a
  contact record was touched — for a domain registered in 1999 and updated this year, a 26-year error in
  the heaviest-weighted signal in the model. First occurrence wins.
- `.be` reports a **registered** domain as `Status: NOT AVAILABLE`. A substring test for "available"
  inverts the answer for an entire ccTLD, so availability is matched against whole field values only.

Dates are normalised from a fixed set of observed formats and anything else yields nothing. `Date.parse`
was rejected for this: it accepts `01-02-2020` happily and resolves the ambiguity by guessing, and a wrong
date is worse than no date, because the age dimension carries it at full weight with nothing downstream
able to tell an inferred date from a published one.

Registry data quirks pass through as the registry states them. JPRS reports `asahi.co.jp` as registered in
2018, which is its record of the current registration rather than the original one. That is the same class
of gap as the drop-catch case below, not a parsing error.

Rate limiting on port 43 is tighter than on RDAP and enforced per source address, which on a serverless
platform is an address shared with every other tenant. Refusals arrive as ordinary body text with no
status code, so they are matched explicitly and reported as `rate_limited`; without that a throttled
lookup would parse as a registry that publishes nothing.

### DNS over HTTPS

- `https://dns.google/resolve?name=X&type=Y`
- `https://cloudflare-dns.com/dns-query?name=X&type=Y`, which requires `accept: application/dns-json`
  and returns 400 without it.
- Records used: A/AAAA, where the `AD` flag gives DNSSEC validation for free; NS; MX; apex TXT;
  `_dmarc` TXT; DKIM selector probes; and `www` for record breadth.
- `<domain>._report._dmarc.<vendor>` TXT, added in `1.3.0`, which is the authorisation RFC 7489 §7.1
  requires before a domain may send DMARC reports to a destination outside its own namespace. This is
  the one request in the model whose answer comes from a party other than the domain being analysed,
  and it is what makes `mail.commercial_rua` the only mail credit still scored. It runs only where a
  commercial vendor was matched in `rua`, so almost every analysis pays nothing for it, and it has to
  follow the `_dmarc` lookup rather than run beside it, since the destination is unknown until that
  record is parsed.
- DKIM probes follow at most one CNAME hop. This covers the delegated selectors used by hosted mail
  systems without allowing a malformed chain to consume the source deadline. Six selectors are tried,
  a list bounded by marginal coverage rather than by how many selectors exist: measured over 4,691
  holdout domains they reach 98.8% of all detections, and each additional entry costs a query on every
  analysis.
- `www` is resolved with a single address query and no separate CNAME lookup. A resolver returns the
  CNAME chain alongside whatever it resolved to, so a `www` that is only a CNAME is already visible in
  that answer; across 4,659 stored transcripts the separate query changed the result for one domain.
- Two MX queries at randomised-looking labels under the domain, added in `1.5.0`, which together answer
  whether the zone publishes a wildcard MX — the capability of receiving mail at every possible address.
  They run only where the domain has an MX record at all, and a wildcard is declared only when both
  labels return the same non-empty set, since one label alone false-positives on resolvers that
  synthesise answers.

  The labels are **derived from the domain by hash rather than drawn at random**, which is a constraint
  imposed by the calibration harness rather than a preference. Recorded responses are keyed by request
  URL, so a label chosen afresh each run would never match what was captured: every replayed analysis
  would report two misses and the lookups would throw, making the holdout unmeasurable. Nothing is
  conceded to an adversary by this, because the label only has to be a name the operator did not create,
  and an operator who drops the wildcard to evade the probe has given up the capability it detects.
- One address query for the mail exchanger, added in `1.5.0`, but **only where that exchanger sits inside
  the domain's own zone** — the shape the throwaway-inbox services instruct their custom-domain users to
  configure. It is deliberately not extended to every unrecognised exchanger, which would spend a round
  trip on a large share of ordinary domains to ask a question their hostname has already answered.
- The net effect on the fan-out is **+2 queries for any domain with mail, and +3 for the minority whose
  mail exchanger names its own zone**. That is the first increase since `1.3.0` cut a third of the DNS
  work, and it is recorded here rather than absorbed quietly: the standing rule is that a query is paid
  for by a fact that can move a verdict, and `docs/CALIBRATION.md` reports what these bought.
- `default._bimi` TXT, removed in `1.3.0` and restored in `1.6.0` **behind a gate that did not exist
  before**: it runs only where the DMARC policy is `p=quarantine` or `p=reject`. That is the BIMI
  specification rather than a saving — a BIMI record has no effect without an enforcing policy, so a
  record published under `p=none` is inert and asking about it would be asking about something that
  cannot be in force. The saving follows from it. Measured over the holdout the gate opens on **5.5% of
  analyses**: 3.8% of abuse domains against 37.7% of legitimate ones.

  The restoration is conditional on the record now being checked rather than read. `1.3.0` removed the
  query because the credit it fed only established that a string began with `v=BIMI1`; the query is back
  because the certificate behind it is now fetched and verified. See `lib/bimi-vmc.ts`.

  The query is kept even though the credit is zero, which is an exception to the rule in the bullet
  below and is argued as one in `docs/SCORING.md`. The short version: the gate makes it nearly free, and
  the reported outcome — including *why* an unverified record failed — is the return on it.
- The six standard business-service names were retired in `1.3.0` and stay retired: `autodiscover`,
  `enterpriseenrollment`, `enterpriseregistration`, `_sip._tls`, `_sipfederationtls._tcp` and
  `_caldav._tcp`. Publishing any of them requires no account with the vendor named, so nothing they
  established could move a verdict, and a fact the model is indifferent to does not justify a round trip
  on every analysis. Together with the original BIMI removal this took the DNS fan-out from 21.7 queries
  per analysis to 14.6 — a third of the DNS work, measured across 4,746 stored transcripts and confirmed
  by counting what the collectors ask for under replay. See `docs/SCORING.md`.

### Verified Mark Certificates — conditional, roughly one analysis in nine hundred

- The URL in the `a=` tag of a BIMI record, fetched as a PEM bundle. There is no fixed endpoint: the
  domain names its own, and the issuers host them, so in practice this is a request to `vmc.digicert.com`
  or an equivalent.
- **It is the only request in the model made to a party the domain merely names**, which needs stating
  plainly given the "no reputation *feeds*" claim elsewhere. What is fetched is a document, and it is
  judged on whether it verifies cryptographically — not on any opinion the issuer holds about the domain.
  A certificate that fails any check scores nothing, and the issuer is never asked what it thinks. The
  one place this model does buy somebody's opinion is the Check-Mail lookup below, which is named as
  such and priced on two fields.
- Two gates in series make it rare. The DMARC gate opens on 5.5% of analyses, and of the holdout domains
  behind it, 5 published a BIMI record and 1 named a certificate: roughly **one fetch per nine hundred
  analyses**.
- Verification is offline once the bytes arrive, over `node:crypto`, with no dependency and no second
  request: validity windows, subject coverage of the domain, each chain link verified against its
  parent's key, and a key above the leaf matched against a pinned Mark Verifying Authority.
- The pinned keys were **derived from observation rather than transcribed**. `scripts/bimi-anchors.mts`
  fetches the live chains of the brands in `benchmark-bimi/` and reports which keys they climb to;
  eighteen unrelated companies agreeing on one DigiCert key is evidence it is an authority key, where a
  fingerprint copied from a vendor page would be an act of faith in the page. The same run corrected the
  authority list, which had omitted GlobalSign.

### Suffix pricing — committed snapshot, no network

- `https://api.porkbun.com/api/json/v3/pricing/get`, no authentication, roughly 900 suffixes with
  registration and renewal prices.
- **Downloaded once by `npm run refresh:pricing` into `lib/data/suffix-pricing.json`, not fetched at
  request time.** The feed answered in 12 to 14 s, which is longer than the whole analysis budget: fetched
  per request the dimension timed out every time, and cached in memory it was still dead for the first
  request of every process. Suffix prices move on the order of months, so snapshot staleness is much the
  cheaper cost. Re-run the script and commit the diff when a registry changes its pricing.
- Observed first-year prices spanned about $1.50 for the cheapest new gTLDs to roughly $28 for the
  expensive technical ones, with the mainstream commercial suffixes between $8 and $13. At the bottom
  of that range an abuser buys seven names for the price of one mainstream registration.
- The renewal-to-registration ratio is the sharper derived signal: the cheapest suffixes renew at ten
  to fifteen times their first-year price, while the mainstream ones renew at parity. A registry
  discounting year one that heavily is selling disposability.
- **Parsing note:** premium prices arrive with thousands separators, so strip commas before parsing.
  A zero is the feed's way of listing a suffix it does not sell rather than a free registration — the
  one in the current snapshot is a closed brand TLD — so a non-positive figure is read as absence. There
  is no free TLD for it to be confused with: the namespaces that were given away are now either back
  with their governments or charging for registration, and the names still issued at no cost are
  subdomains under a provider, which the provider-suffix table scores directly.
- **Coverage is the mainstream retail market, not every suffix.** The feed is one registrar's catalogue,
  so it carries roughly 900 suffixes and only the 94 second-level ones that a Western registrar sells. The
  second-level national namespaces are largely absent, as are the ex-free ccTLDs. A suffix it does not
  sell is matched exactly and reported as unpriced; no price is inferred from the parent suffix, because
  a registry's second-level namespaces routinely cost a tenth of its base ccTLD and the inherited figure
  therefore hides the cheapest suffixes in existence.

#### Amending the snapshot from other price sources — rejected

Measured while looking for a price for a second-level namespace the feed omits.

| Source | Observed |
| --- | --- |
| Registry fee schedules published by the ccTLD operator | Authoritative and free, and the closest thing to an abuser's real cost basis, since several registries publish both a wholesale fee and a minimum retail price. But they are per-registry PDFs in local currency, quoting figures that need an exchange rate to compare, and each one covers a single country. Roughly 200 registries would have to be tracked individually to close the gap. |
| Registrars local to the registry | The genuine market price, including the promotional pricing an abuser actually buys at. Same problem: per-country, per-currency, HTML only, and promotional figures move week to week. |
| Western registrars that resell exotic ccTLDs | Available and machine-readable, and **actively misleading**. One boutique European registrar lists three second-level namespaces at $30 a year that retail locally for two or three dollars, because it charges a flat handling premium on anything exotic. Adding it would have moved the number further from the truth than having none. |
| Price-comparison aggregators | The only sources with both broad second-level coverage and a cheapest-registrar view, which is the right aggregation. All of the ones checked require an account and an API keypair, which no other source in this project does. |

Absence is therefore left as absence, reported to the reader and scored zero, which generalises across
countries in a way that a backfill could not. See `docs/SCORING.md`.

### Live site probe

- One HTTPS root fetch, falling back to http with whatever the first leg left of a shared budget, with
  redirect tracking capped at 5 and the body read capped at 256 KB. That is the whole of it: the
  `robots.txt` request was retired in `1.2.0` along with the signal that read it, which is one fewer round
  trip inside the site budget.
- Answers only one question: does this domain do anything other than receive mail.
- **Every hop faces the same host rules the submitted input did.** The chain is followed in `lib/fetch.ts`
  rather than by the runtime, which caps at twenty hops and revalidates nothing between them. A redirect
  target is a host chosen by the domain under analysis, so without the boundary's own test — no address
  literals, no reserved names, no other schemes — the gate covers exactly one request, and a domain
  answering `302 http://169.254.169.254/` has its target fetched, read, and reported back with the status,
  size and title attached. A refused chain returns the redirect itself: reachable, not substantive, with
  nothing about the destination read or shown. A public name resolving to a private address still passes,
  which needs address pinning rather than a string test and is not attempted.
- The final redirect host is classified from a bundled table. Known parking destinations become parking
  evidence; nothing else about the destination is scored, since the off-domain redirect penalty was
  measured and removed. A redirect still costs the domain the content credit, because a root that
  forwards elsewhere never serves the page itself.
- **Soft 404s are detected by status code, not body size**, since a large custom error page is
  otherwise indistinguishable from a real page.
- The response headers and body are also read for website-platform markers, added in `1.6.0`. This costs
  **no request at all**: it inspects the fetch already made and the addresses already resolved. Its
  predecessor `configuration.hosted_service`, removed in `1.2.0`, did cost a query — an apex CNAME lookup
  whose destination the domain chose — and the reason this one can exist is precisely that it asks a
  question the bytes on hand already answer. See `lib/data/site-platforms.ts`.

### Check-Mail — third-party reputation (optional, metered)

The only source here that returns somebody else's conclusion rather than an observation, and the only
one that costs money. It exists because of a gap nothing else in this system can close: every other
signal reads what a domain publishes about itself, and a name registered an hour ago by an operator who
has already burned a thousand others publishes exactly what an innocent new name publishes. A vendor
watching signups across its own customer base sees that history. This model cannot.

- `POST https://api.check-mail.org/v2/` with `Authorization: Bearer $CHECKMAIL_API_KEY` and a form body
  of `domain=<name>`. The vendor's auth documentation specifies POST while its homepage and FAQ both
  describe a GET, so the collector falls back to GET on a `405` rather than depending on which page is
  current.
- **1,000 lookups a month on the free tier.** This is the only source with a marginal cost per request
  and the only one that can go dark mid-month with every upstream healthy, so
  `x-ratelimit-requests-remaining` is read from the response and reported against the source even on
  success. Without that, exhaustion is invisible until the day it happens.
- **No key, no problem.** The collector reports `unsupported`, the signal does not fire, and no other
  dimension changes. This is the state the test suite runs in, pinned in `vitest.config.mts`.
- **Never runs during calibration.** `lib/analyze.ts` skips it whenever a recording or replay context is
  active. A collection pass covers several thousand domains against an allowance of one thousand, so
  running it there would spend the month in a single pass and produce a column that was mostly
  rate-limit failures — worse than an absent column, because it would look measured. The consequence is
  that its weights are the only ones in the model never validated against the holdout, and the audit
  reports it as `KEEP no data, source never answered`.
- **Only two of its fields are scored**, the disposable verdict and the risk score. Three more are
  stored and shown as evidence and deliberately never priced, each because it would smuggle back a
  judgement this model examined and rejected:
  - `block` is the vendor's own recommendation, and is true when a domain is *either* invalid *or*
    disposable. Deliverability was rejected as a signal here on the reasoning that an account farmer
    has to receive the verification message, so working mail is a precondition of the abuse rather than
    evidence of it.
  - `valid` is that same objection stated directly.
  - `is_email_forwarder` duplicates a classification whose penalty the audit removed after it fired on
    twelve families, none of them abuse. The position since is that alias capability is flagged for the
    reader rather than condemned, and reading this field would reinstate the penalty at full weight
    through a third party.
- **Platform-issued names are queried rather than skipped**, unlike RDAP and pricing. The vendor answers
  at the registrable parent, and for a free-subdomain provider the parent's reputation is frequently the
  most informative thing available. Where the returned `base_domain` differs from the name submitted,
  the evidence string names the parent, so a penalty is never presented as though the subdomain earned
  it.

### Bundled tables (no network)

MX fingerprints carry the primary dimension, so they are code versioned with the model rather than a
feed fetched per request. Verified classes:

| Class | Fingerprint approach |
| --- | --- |
| Free custom-domain routing | Matched on mail-exchanger hostname suffix, because the routing names are per-account and versioned under a stable parent. The dominant provider in this class is corroborated two further ways: every routing target resolves inside one small IPv4 prefix, and the provider publishes a well-known SPF include. |
| Registrar free forwarding | Bundled free with any domain at the registrar and catch-all capable. Its paid mailbox product resolves elsewhere and is the opposite signal. |
| Free tiers of hosted mail | Several providers accept any custom domain on a free plan. Where a provider's free and paid tiers share mail exchangers they cannot be separated from DNS, which is noted in the table. |
| Temp-mail | Throwaway-inbox operators self-brand their mail exchangers, and keep the same ones as they rotate front-end domains. |
| Temp-mail endpoints | The IPv4 addresses those services publish in their own custom-domain setup instructions, matched only where the mail exchanger sits inside the domain's own zone and so names nothing useful. This is adjacent to the hosting reputation rejected below, and the distinction is that it matches a specific documented mail endpoint rather than judging an ASN or a prefix; the precedent is the routing-prefix corroboration that has shipped since `1.0.0`. Entries come from provider documentation only — fitting them to the labelled holdout would make every figure that holdout then produced circular. An endpoint that moves silently stops matching and costs nothing. |
| Temp-mail ownership tokens | The apex TXT tokens those services ask a customer to publish to prove control of a domain. Read out of a record already fetched, so it costs no query. Restricted to apex-visible tokens: a provider that puts its token at a dedicated subdomain would cost a lookup on every analysis to find a record almost no domain has. |
| Alias forwarders | Unmistakable per-provider mail exchangers. The boundary against the temp-mail table above is whether the inbox expires: an alias that lives until its owner deletes it, forwarding to a mailbox they already had, is this class and not that one, which matters because that table is consulted first and at more than three times the weight. |
| Shared relay domains | Matched on the submitted domain, since relay users receive mail at the provider's domain and never point their own MX. |
| Paid mail tenancy | Business suites, enterprise mail gateways and the paid-only privacy hosts, used as a weak positive. Membership turns on the bill scaling with the mailbox, which is what makes a match evidence of spend on this domain rather than of a subscription the operator already held. |
| Consumer mail infrastructure | Matched on mail exchanger so that a large free provider's vanity domains route to `out_of_scope` generically, instead of requiring every one to be enumerated. |
| Registrar defaults | Requires the RDAP registrar identity, its default nameservers and its bundled forwarding MX to agree. No component is negative alone. |
| Redirect targets | Known parking, hosted-site and public-profile destinations are classified locally; an unrecognised external destination remains unknown rather than guessed. |
| Website platforms | Per platform: the markers its edge emits, the address ranges it publishes for custom domains, and whether attaching one requires a paid plan. Only the address ranges support a credit, since headers and asset references are what a server chooses to send. Ranges are listed only where the platform answers from its own space — several front their edge with a general-purpose CDN, and a range identifying Cloudflare rather than the platform is worse than none. Two entries are load-bearing corrections rather than data: Ghost is marked as not implying payment because it is self-hostable, and a Squarespace parking page is never read as a platform serving a domain, because Squarespace is also a registrar. |

Two tables that sat here are gone, each with the only credit that read it. A custom-domain website-platform
table, matched on apex or `www` CNAME target and split so that a free platform did not imply spend, went in
`1.2.0` with `configuration.hosted_service` and the apex CNAME lookup that fed it. A business-services
table, classifying autodiscovery, enrollment, SIP and calendaring targets into vendors, went in `1.3.0` for
the reason above: pointing a CNAME or SRV record at a vendor requires no account with that vendor.

Two providers were drafted into these tables and declined on the tables' own criteria, recorded here
because both look like obvious members and the work is otherwise repeated. A registrar's free forwarding
was proposed for free custom-domain routing and fails it, publishing that catch-all and wildcard
forwarding are unsupported and capping a domain at twenty addresses: the thousandth address is not free
there, it is unavailable, and that capability is the whole reason the class carries the weight it does.
A consumer cloud subscription's custom-domain mail was proposed for paid tenancy and fails it, because
one subscription of about a dollar a month carries five domains, so a match evidences a subscription the
operator already had rather than spend on the domain in front of us. Both are left unmatched rather than
placed somewhere gentler, which costs nothing: the exchanger goes unrecognised and the surrounding
signals decide. The audit is what made both visible, in the same way it corrected the vetted-suffix list,
and both were declined on the criterion rather than on the handful of labelled domains they touched.

Because SMTP port 25 is unavailable from the deployment target, catch-all capability cannot be probed
directly, and this MX-class inference is the substitute.

Public suffix parsing uses `tldts`, including the PSL private section, so platform-owned suffixes are
recognised. Registration age there belongs to the provider and is meaningless for the name beneath it.
The PSL is incomplete for free-subdomain and dynamic-DNS providers, so a supplementary table covers
them.

## Rejected, with the observed reason

| Source | Reason |
| --- | --- |
| RDAP redirector service | Timed out at 15 s twice, and 404s for suffixes that genuinely have no RDAP. |
| crt.sh JSON endpoint | Returned `502 Bad Gateway`. |
| A well-known URL blocklist API | Now returns `401 Unauthorized` without an auth key. |
| Spamhaus DBL over DoH | Answers `need.to.know.only`; public resolvers are blocked. |
| Browser HSTS preload list | 10 MB JSON, not worth the fetch. |
| A public resolver's JSON API on a non-standard port | Timed out. |
| Several protective resolvers | No JSON API exists; DNS wireformat only. |
| A community disposable-domain list at its documented raw path | 404, the file had been renamed. |
| SOA serial as an age proxy | Weak. For a non-existent name the SOA comes from the parent zone, and for existing ones the serial tracks zone edits rather than creation. |

## Removed by design

Not failures — deliberate scope decisions, recorded so they are not relitigated.

**No third-party reputation *feeds*.** Originally this read "no third-party reputation lookups at all",
and `1.4.0` narrowed it rather than deleting it, because most of what it decided still holds and the
part that changed is worth being precise about.

What it removed remains removed: the downloadable disposable-domain lists and the protective-DNS
consensus across several filtering resolvers, along with the wireformat DNS dependency that existed only
to query them. Those were bulk feeds with a per-request download cost and a staleness problem, and a
model built on them cannot generalise to a domain registered minutes ago that nothing has seen yet.

What changed is the reasoning about a single point lookup. The rejection had assumed a feed; a query
about one domain has no staleness cost of its own, and the gap it closes — cross-customer abuse history,
which nothing observable about a domain reveals — is precisely the gap the rest of the model cannot
reach by design. So one metered lookup is now consulted, bounded so that the original position still
governs everything else: it is optional, it holds no weight in confidence, it is one signal in one
dimension, and every structural signal scores identically with it absent. The stated limitation below is
unchanged for a deployment without a key, and softened only in proportion for one with a key.

**Deliverability checks**, meaning RFC 7505 null MX, dangling MX and the no-MX cases. The reasoning
inverts under this threat model: an account farmer must receive the verification or OTP message, so
working mail is a precondition of the abuse rather than evidence of it. An undeliverable domain
describes a signup that fails at verification anyway, which the signup flow establishes for free. It
also cannot discriminate, because every domain the model hunts will pass it.

**Local-part heuristics** in full, including entropy, keyboard walks, trailing-digit templates,
throwaway vocabulary, role addresses and dot or plus-tag canonicalisation. Legitimate bulk patterns are
common and indistinguishable from farmed ones: a teacher registering a class, a family, or a team
creating sequential accounts all produce exactly those shapes. The false-positive cost lands on
ordinary users rather than abusers. A full address is still accepted as input, but the local part is
discarded.

**Popularity ranking.** It cannot separate the two populations that matter: large free providers are
unblockable at domain level and handled by the out-of-scope short circuit, while real small businesses
are absent from popularity lists entirely.

**Brand-impersonation signals**, including punycode and homoglyph scoring, mixed-script detection,
brand edit distance and brand-plus-keyword heuristics. These are phishing concerns, not account
farming. IDN to A-label normalisation stays, because lookups fail without it, but it is plumbing rather
than a scored signal.

**Phishing feeds.** Near-zero recall for signup abuse, and a multi-megabyte fetch per request is
indefensible.

**Live TLS handshake.** Phishing-oriented, so it was dropped on its own merits. The secondary argument
for dropping it — that it removed the last need for raw outbound TCP from a serverless function — no
longer applies, since the port-43 collector reintroduced that dependency deliberately. What changed is
that the dependency is now paying for the anchor signal wherever RDAP cannot answer, across the 872
suffixes that publish a port-43 server, rather than for a phishing check the threat model does not want.

**Hosting reputation** as a whole: ASN and prefix lookups, DROP list membership and PTR checks. A farm
domain often has no website at all, so its hosting says little, and the traps are real: shared reseller
hosting in a recently allocated prefix is how a great many legitimate small businesses are hosted.

**URL scanning services, passive DNS and technical-news mentions.** All returned nothing useful for a
real low-traffic business, so they cost latency to confirm silence.

**Certificate transparency**, in full. The unauthenticated issuance endpoint returns a paginated recent
window, so a domain registered fifteen years ago can report a first issuance only months old. That
restricted it to raising a *lower bound* on age, which the registration record already establishes
better wherever it exists — and where it does not, the bound was too weak to reason from. Certificate
name breadth went with it: it duplicated what DNS record breadth already measures, at the cost of a
whole source. The detail beyond a first-seen bound was never in scope either: OV/EV subject bonuses,
SAN sibling clustering, issuance velocity, and wildcard or SAN-sprawl checks.

**The web archive index.** It was kept as the only independent age source for the suffixes that publish
no RDAP, and it did not earn that. It was the slowest source measured by a wide margin, timed out
entirely at 20 s during calibration, and needed a separate extended deadline in the orchestrator to have
any chance at all. What it bought was a lower bound on age for a minority of domains, which is not worth
a source that usually fails. Age now comes from the registration record alone.

Removing both also removes the drop-catch override, which needed an independent history to establish a
gap against the registration date. RDAP's `lastChanged` fires on any modification at all, so it cannot
substitute: on its own it penalises well-run domains for being actively maintained. Age credit is
therefore inherited by whoever recaught a lapsed domain, which is a known gap.

**MTA-STS, TLS-RPT and CAA.** MTA-STS was NXDOMAIN even for major financial and broadcast domains that
do everything else right. CAA costs a query for a near-zero-weight signal.

**Content maturity extras**: `ads.txt`, app-association files, security headers, analytics IDs, favicon
hashing and sitemap analysis, plus scam-shop heuristics such as wallet prompts, messaging-app contact
links and "established since" contradictions. The messaging-app check in particular encoded a
geographic bias against legitimate businesses.

## Deferred

**Cohort detection**, which requires storage. The same registrar plus the same nameservers plus
creation timestamps inside the same minute identifies bulk registration directly, and it is among the
strongest available signals for account farming. `DomainFacts` retains the raw registrar, nameserver
and creation-timestamp values so this becomes possible without a re-crawl. It remains deferred: every
signal currently evaluated by the service is stateless.
