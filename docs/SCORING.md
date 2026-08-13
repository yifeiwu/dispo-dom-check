# Scoring model

Model version: `1.3.0`

This document is the specification. The implementation lives in
[`lib/scoring/weights.ts`](../lib/scoring/weights.ts), which is the single place any weight,
threshold, clamp, band boundary or override rule is allowed to exist. If this document and that file
disagree, the file wins and this document is stale.

`GET /api/model` returns the active config plus every signal and combination definition with its
rationale. The `/how-it-works` page renders from that endpoint rather than from this prose, so what
users read cannot drift from what the scorer does.

## Threat model: bot signups, not phishing

The abuse being detected is mass account creation. The question is not "is this domain malicious" but
"can this domain mint unlimited mailboxes cheaply, and was it created to do so". Every priority
follows from that:

- Disposable and forwarder mail detection is the primary dimension. The core capability an account
  farmer needs is one domain yielding unlimited deliverable addresses.
- Registration economics and age come next. Price plus age plus mail-provider class captures most of
  the value; everything else is refinement.
- Phishing-oriented signals are excluded. Signup-abuse domains are not phishing domains.
- Output is signup risk plus explicit reason-code flags, so a consumer can act on a reason rather
  than only a number.

Every credit keys on evidence **somebody other than the domain had to supply**, which is the thing an
account farmer cannot mint at scale.

That rule replaced a weaker one in `1.3.0`. The model used to say it scored "effort and cost invested in
the domain", and for age, price and accreditation it did. For mail posture, organisational footprint and
half of configuration it did not: those dimensions read TXT, CNAME and SRV records that the domain writes
about itself, and nothing checked any of them against the party they named. A verification token was
matched by prefix and never confirmed with the vendor. A BIMI record was paid +8 for implying a purchased
certificate that was never fetched. An SPF `include:` naming a paid platform required no account with it.
Together they came to 44 points of credit available to anyone with a text editor, which is more than the
entire age dimension can pay. Nine of those credits now score zero, and the one that could be verified
cheaply is verified. See the changelog.

## Two outputs, never one number

| Output | Range | Meaning |
| --- | --- | --- |
| `legitimacy` | 0-100 | Additive evidence points from a neutral 50. `risk` is `100 - legitimacy`. |
| `confidence` | 0-100 | Weighted coverage of the dimensions that actually returned data. |

Confidence exists because absence of evidence is not evidence of abuse. A legitimate new small
business and a fresh farm domain look similar, so the model must be able to say "insufficient
evidence" rather than accuse. Below a confidence of 40 the verdict becomes `insufficient_evidence`
regardless of the band.

The governing rule for the whole model: **penalise only on positive evidence of a problem.** A source
that is unreachable, rate limited or unsupported contributes no points in either direction and only
lowers confidence.

## Age is the anchor

```
firstSeen = registration.creation        # RDAP where the registry publishes it, WHOIS where it does not
```

There is deliberately no *substitute* source. Certificate transparency and web archive captures both used
to feed this estimate, and both could only ever **raise a lower bound** on age rather than establish it,
because each observes when a domain was first *used* rather than when it was created. A bound that weak
did not justify two sources, one of which usually timed out. See `docs/SOURCES.md`.

The two registration protocols are not a fallback in that sense: both report a real creation date, so
neither is an approximation of the other. RDAP is nonetheless preferred wherever it responds, and port 43
is read only where it has not — either the suffix publishes no RDAP service at all, or the server exists
and never answered. A registry that answered and declined is not a gap and is not re-asked. See
`docs/SOURCES.md`.

The consequence is narrower than it was. A suffix publishing neither yields no age, and so does one whose
registry answers over WHOIS without publishing a registration date — DENIC, nic.at and EURid all do
exactly that. Both cases are reported as missing evidence, which lowers confidence, and never as youth.

## Dimensions and point tables

Every dimension is clamped so none can dominate. Clamps are listed with each dimension.

### Signup capability (clamp -40 to +7) — primary

| Signal | Points | Flag |
| --- | --- | --- |
| MX at a temp-mail provider | -40 | `disposable` |
| Free unlimited-alias routing on a custom domain | -21 | `catch_all_capable` |
| MX at an alias forwarder | -12 | `forwarder` |
| Submitted domain is a shared alias-relay domain | 0 | `forwarder` |
| Reputation service calls the domain disposable | -40, plus its risk tier | `disposable` |
| Reputation service scores risk at 90 or above | -12 | |
| Reputation service scores risk at 75 to 89 | -6 | |
| Reputation service answered and knows nothing against the domain | +1 | |
| MX at a paid business mail tenant | +6 | |

Forwarders are flagged rather than condemned: they are legitimate privacy tools that also happen to be
ideal for multi-account creation, so the policy decision belongs to the consumer. In `1.2.0` the
relay-domain row was brought into line with that sentence, which it had been contradicting with a -12
penalty since `1.0.0`. The flag is unaffected.

The four reputation rows are one signal reading a third-party verdict, and they are the only rows in
this document never validated against the holdout — the source is metered and excluded from calibration
by construction, so its numbers are judgement rather than measurement. Three consequences follow from
pricing its disposable verdict at the same -40 the MX table charges:

- Where the verdict is disposable the dimension floor is already reached, so the risk tier is absorbed
  and changes nothing. The tiers only decide an outcome where the domain is *not* called disposable.
- Where this model and the vendor agree, the second verdict costs nothing extra. Two sources reaching
  one conclusion is corroboration rather than two problems.
- A free-routing domain the vendor also calls disposable now lands at -40 where it previously sat at
  -21. That is an unmeasured signal changing the effective reach of a measured one, and it is the
  clearest cost of this addition.

The `+1` is the single exception to the rule that this model penalises only on positive evidence, and
the rule holds everywhere else. It exists because the alternative is scoring zero, and a zero renders in
a collapsed section: a reader would have no way to tell a domain the vendor cleared from one the vendor
was never asked about. The honest cost is that it lands mainly on domains no feed has caught yet, which
is the population the model exists to find, and that a domain analysed after the monthly allowance runs
out scores one point below the same domain analysed the day before. One point cannot move a band, which
is the entire reason the exception is affordable at this size and would not be at any larger one.

The vendor's `block`, `valid` and `is_email_forwarder` fields are shown as evidence and never scored;
`docs/SOURCES.md` records which rejected judgement each one would reintroduce.

### Registration economics (clamp -18 to 0)

| Signal | Points |
| --- | --- |
| Suffix first-year price under $2 | -12 |
| Suffix first-year price $2 to $5 | -8 |
| Suffix first-year price $5 to $10 | -2 |
| Suffix first-year price $10 or more | 0 |
| Renewal-to-registration ratio above 10x, inside first term only | -6 |
| Renewal-to-registration ratio above 5x, inside first term only | -3 |
| Suffix absent from the reference price list, unless accredited | 0, reported to the reader |
| Name issued free by a subdomain or dynamic-DNS provider | 0, still read by `combo.farm_profile` |

The dimension has no positive side. The vetted-suffix credit used to be paid here as well as in the name
dimension, which meant one fact earning points twice and clearing two clamps instead of one; it is now
paid once. The clamp maximum went with it, because a bound of `+4` over a dimension that cannot produce a
positive number is not a safety margin, it is a bound that never binds.

Every price here belongs to the suffix, not to the domain being scored. It is the list price of any
registration under that suffix, taken from a registrar catalogue, and nothing in the model knows what
this particular name actually sold for. A premium or resold name can cost orders of magnitude more
than list, so a cheap-suffix penalty says the namespace is cheap to buy into in bulk, which is the
unit-cost claim the threat model rests on, and never that this registrant paid little.

The ratio matters because abusers pay only the first year, so a registry discounting year one heavily
is selling disposability. It applies only inside the first registration year, since a renewed domain
has already paid the real price.

The price list is a single registrar's catalogue, so it describes the mainstream retail market rather
than every suffix in existence. No price is inferred for a suffix it does not carry. The parent suffix
used to serve as a bound, which was wrong in the direction that hides abuse: second-level national
namespaces undercut their own ccTLD heavily, so `web.id` inherited `.id` and read as an $18 domain when
it retails near $2.

The absence is reported to the reader and scored zero, because it has two explanations with opposite
signs and nothing in a price list distinguishes them. The suffix may not be openly registrable, which
is the same argument that earns an accredited suffix `+4`; or it may be sold only by registrars local to
its registry, which is where the cheapest namespaces in existence live. Guessing either way would
penalise national namespaces for being national, or credit the ex-free ccTLDs for being obscure. What
the model does instead is say so, and let the missing dimension lower confidence. Where accreditation
already answers the question the note is suppressed, since the vetted-suffix signal covers that case.

### Age and registration (clamp -30 to +20)

| Age | Points |
| --- | --- |
| Under 7 days | -30 |
| 7 to 30 days | -22 |
| 30 to 90 days | -14 |
| 90 to 180 days | -8 |
| 180 to 365 days | -3 |
| 1 to 2 years | +4 |
| 2 to 5 years | +10 |
| 5 to 10 years | +16 |
| Over 10 years | +20 |

| Additional signal | Points |
| --- | --- |
| Registration term of exactly 1 year | -3 |
| Inside first term, expiring within 60 days, not renewed | -10 |
| RDAP `serverHold` or `clientHold` | -25 |
| RDAP `pendingDelete` or `redemptionPeriod` | -10 |

### Mail posture (clamp -6 to +4) — confirmed, not merely published

Depth of configuration was the discriminator here until `1.3.0`, on the reasoning that presence of SPF and
DMARC stopped meaning anything once the 2024 bulk-sender rules pushed everyone to publish them. Depth
turned out to be no better: every part of it is a tag the domain writes in its own zone, so what the
dimension measured was what an operator was willing to type.

| Signal | Points |
| --- | --- |
| DMARC `rua` at a commercial vendor **that published the RFC 7489 authorisation record** | +4 |
| DMARC `rua` naming a commercial vendor that has not | 0, reported to the reader |
| SPF present | 0, reported |
| DMARC `p=reject`, `p=quarantine` or `p=none` | 0, reported |
| Strict alignment (`aspf=s` or `adkim=s`) | 0, reported |
| Explicit subdomain policy (`sp=`) | 0, reported |
| SPF includes naming paid SaaS senders | 0, reported |
| SPF ending in `+all` | -4 |
| MX and a live site but no SPF at all | -3 |

The reporting vendor is the exception because RFC 7489 §7.1 makes it checkable. Sending aggregate reports
to a destination outside the domain's own namespace requires that destination to authorise it, by
publishing a DMARC record at `<domain>._report._dmarc.<vendor>`, and only the vendor can create that. It
is one DNS query, it runs only where a vendor was named, and it is the single place in the model where a
third party is asked to confirm something.

The tri-state matters. A vendor that has not vouched for the domain earns nothing, and a query the
resolver could not answer also earns nothing, because silence is not a refusal. Neither is a penalty:
withholding a credit is the whole of the effect.

**Absent DMARC is never penalised on its own,** and now neither is its presence rewarded. Plenty of
legitimate small businesses never set it up. The only negatives are affirmative misconfigurations.

**The presence of inbound mail scores nothing in either direction.** Absence was never penalised, on the
grounds that an account farmer has to receive the verification message; the same argument rules out
paying for presence, which is why the `+2` that used to sit at the top of this table is gone. See the
removals below. Whether a domain can receive mail is still read as a fact, by the two conjunctions that
require it and by the mail-only-zone penalty, but on its own it is not evidence.

### Configuration effort (clamp -10 to +10)

The best available proxy for whether a human set this domain up for a purpose beyond receiving mail.

| Signal | Points |
| --- | --- |
| Record breadth: MX with no web host and no `www` | -10 |
| Record breadth curve across apex, `www`, mail host and MX | up to +8 |
| Site title contains the domain label | +4 |

Breadth counts only records that have to point at a host. SPF, DKIM, vendor verification and business
services were dropped from the count in `1.3.0`, because a zone can be filled with TXT records saying
anything at no cost, and because the last three were simultaneously earning their own credits in the
footprint dimension — one set of invented records clearing two clamps instead of one, which is the exact
accumulation the clamps exist to stop.

The mail-only penalty is tested against the non-mail classes by name rather than by counting how many
classes were present, which had coupled the penalty to the credit: trimming the list would otherwise have
silently widened the penalty onto every domain whose only other record was an SPF string, which is an
ordinary mail-only setup rather than a farm.

This is the one clamp positioned by measurement rather than by what its signals can reach, and it binds:
the dimension can produce +12. The two credits overlap, since the domain with wide record breadth is
usually also the one whose title matches its own label, so the pair pays twice for a single underlying
fact. Bounding the sum was preferred to repricing either signal, because each is well-behaved alone.

### Organisational footprint (clamp 0 to +3)

| Signal | Points |
| --- | --- |
| DNSSEC validated (`AD` flag) | +3 |
| 5 or more, 2 to 4, or exactly 1 distinct SaaS verification vendor in apex TXT | 0, reported |
| DKIM selectors present | 0, reported |

The dimension was built on the premise that a verification record is the residue of someone completing a
domain-verification step inside a paid product. The residue is indistinguishable from the thing itself:
the census matches a TXT prefix, no vendor publishes any way to confirm a token it issued, and five
invented strings earned the top tier of +12. DKIM keys are free to generate, and only the DNS half of
signing is observable.

DNSSEC survives and is the reason the dimension still exists. The resolver validated the chain to the
root cryptographically, so the `AD` flag is somebody else's arithmetic rather than the domain's claim. It
is cheap to enable, which is why it pays little, but it cannot be asserted.

This dimension is positive-only, because having none of these records is the normal condition of a
legitimate small business rather than evidence of anything.

### Site existence (clamp -12 to +6)

| Signal | Points |
| --- | --- |
| HTTPS 200 with substantive titled content | +6 |
| Immediate redirect off the domain, to any destination | 0 |
| Parking fingerprint or parking nameservers | -12 (flag `parked`) |
| No A record while under 30 days old | -6 |

Soft 404s are detected by status code rather than body size, because a large custom error page is
otherwise indistinguishable from a real one.

An off-domain redirect is neutral rather than penalised, which is a measured result rather than an
oversight; see the removals below. It still withholds the content credit, because a root that forwards
elsewhere never serves the page itself, so redirecting costs a domain the +6 without charging it
anything.

### Name pattern (clamp -5 to +15)

| Signal | Points |
| --- | --- |
| Template-like word plus 3 to 6 trailing digits | -5 |
| Restricted or vetted suffix | +15 |

The dimension is deliberately thin. Character-histogram measures of the label, entropy and hyphen
counting, were built and then dropped after the benchmark showed they select legitimate domains ahead
of abuse at every threshold that fires at all. See the removals below.

The vetted-suffix credit is the largest single number in the model, so what belongs on the list matters
more than the weight does. The entry criterion is that the suffix is gated by accreditation, and a suffix
that merely reads as institutional does not qualify. Two entries were removed in `1.2.0` for failing it, and
between them they were most of what the signal had been doing: `edu.pl`, which is one of NASK's functional
domains and sells to anyone in realtime for about $4, and `edu.eu.org`, which sits under a suffix this
same codebase classifies as a free-subdomain provider. Before the fix the credit fired on 28 abuse
domains against 8 legitimate ones and read as actively harmful; after it, on 13 families with an abuse
share well below the base rate.

## Combinations

A purely additive model errs in both directions: it misses conjunctions where each part has an
innocent explanation that only the combination eliminates, and it double-counts correlated signals,
which is how a legitimate small business accumulates penalties for being unsophisticated.

Evaluation order is fixed: **signals, discounts, bonuses, overrides, per-dimension clamps, bands.**
The total contribution from all combinations is capped at 40 points of magnitude.

### Superadditive (`bonus`)

| Combination | Points | Why the conjunction matters |
| --- | --- | --- |
| Farm profile: cheap suffix with no brake on disposal, inside first term, MX configured, no real website | -25 | Each part alone is innocent. A new cheap domain may be a startup; a mail-only domain is a legitimate setup. Together they describe a domain whose sole function is receiving mail at throwaway cost. |
| Free unlimited-alias routing, under 90 days old, no website | -15 | Routing alone is common among hobbyists. On a young cheap domain with no site, that explanation is gone. |
| Inbound configured, outbound identity absent | -10 | MX at a free or alias provider while SPF, DKIM and DMARC are all missing. This uses absence without violating the absent-DMARC rule, because the signal is the pairing of unlimited inbound aliasing with zero investment in sending identity. |
| Parked or contentless page with MX present | -8 | Parking normally implies no mail at all. |
| Registrar defaults, bundled forwarding, under 90 days old, no website | -8 | Default delegation is harmless alone. When the registrar, nameservers and forwarding MX all agree and nothing else was built, the untouched mailbox-only template is affirmative evidence. |

### Sign-flipping (`override`)

These matter more than bonuses because they invert a signal rather than nudging it.

| Combination | Effect | Why |
| --- | --- | --- |
| Conclusive legitimacy: vetted suffix, over 2 years old, paid mail tenant | Floors `legitimacy` at 80 | No plausible farm domain has all three. Positive overrides keep false-positive pressure off the established. |

There is deliberately no drop-catch override. Detecting a lapsed and recaught domain needs an
independent history to establish a gap against the registration date, and with certificate and archive
history removed there is none. Age credit is therefore inherited by a new owner, which is a known gap.

### Subadditive (`discount`) — the half that protects legitimate small businesses

| Group | Effect | Why |
| --- | --- | --- |
| Missing DMARC, missing DNSSEC, zero SaaS verification records | Reported, nothing charged | Three measurements of a single latent factor, an unsophisticated operator, which describes most legitimate small businesses. |

The group carried a scale of `0.3` until `1.3.0`, and it no longer carries one. A discount multiplies
points, and after that release there are no points on any of its three members to multiply: absent DMARC
was never penalised, absent DNSSEC never was either, and the vendor census went to zero with the rest of
the self-asserted credits. Keeping the scalar would have left a number that reads as a live protection
while multiplying nothing, which is the defect the clamp comments in `lib/scoring/weights.ts` exist to
prevent. What replaced it is stronger and needs no tuning, since a signal that scores zero cannot
accumulate at any scale. The combination still fires and still reports itself, so a reader can see the
conjunction was noticed and deliberately not held against the domain.

The cheap-price-plus-high-renewal discount was removed in `1.2.0`. Its reasoning was sound — the two are
strongly correlated, since cheap suffixes almost always discount year one — but a discount in this half of
the model is supposed to protect legitimate but unsophisticated domains, and this one protected nobody it
was written for. It applied to 30% of abuse domains and 0% of legitimate ones, because a legitimate
business on a suffix that is both cheap and steeply renewing is close to a null set. Removing it took 24
abuse domains out of a legitimate band at no cost to any legitimate one, and freed `economics.renewal_ratio`
to measure something: at 0.6 scale it was worth nothing to the model, and at full weight it is one of the
signals with a positive interval.

### Confidence adjustments

Genuine conflict lowers confidence and is surfaced rather than averaged away, such as a domain more than
a decade old whose mail is handled by a temp-mail provider.

### Overfitting guardrail

Interaction terms are where overfitting enters, and each is a hand-crafted prior rather than a learned
weight. The set stays small, each carries a written rationale, each is pinned by a fixture, and the
total is capped.

## Overrides and verdict bands

Applied after summation, in order:

1. A major consumer mail provider short-circuits everything with `out_of_scope: shared_free_provider`
   and no score. A domain whose mail is handled by consumer mail infrastructure is treated the same
   way, since it is a shared provider vanity domain.
2. An RDAP registry hold (`serverHold` or `clientHold`) caps `legitimacy` at 10. This is the only hard
   cap: the registry suspending a domain is the one external verdict the model treats as decisive, and
   the reputation lookup is deliberately not another — a commercial classifier is a weighted signal, not
   an authority over the name.
3. A provider-owned suffix suppresses all registration-age, economics and registrar signals, because
   the age belongs to the provider, and marks the result as scoped to the subdomain.

Band boundaries are positioned from the measured distributions of a labelled holdout rather than chosen
for roundness, since the two distributions cross at about 55. See `docs/CALIBRATION.md`.

| Band | `legitimacy` | Verdict |
| --- | --- | --- |
| High risk | 0-18 | `high_risk` |
| Suspicious | 19-39 | `suspicious` |
| Unclear | 40-54 | `unclear` |
| Probably legitimate | 55-69 | `probably_legitimate` |
| Established | 70-100 | `established` |

Three of the four edges moved in `1.3.0`. Zeroing the self-asserted credits took the top off the
legitimate distribution — its median fell from 80 to 68 on the collection those two versions shared, and
measures 70 on the fresh one — and bands calibrated against a scale where an ordinary business could reach
100 do not survive a change that caps it near 88. Leaving them would have doubled the false-positive rate
to 12% rather than holding the operating point the model has always been tuned to.

The `probably_legitimate` floor is the one that did not move. It was 58 under `1.0.0`, followed the
distribution down to 55 when the `+2` for MX presence was removed in `1.1.0`, and has now held through a
twentyfold increase in the abuse sample, every removal in `1.2.0`, the largest single change to the scale
the model has had, and a complete re-collection of the holdout. It is still the crossover, at a Youden J of
0.683 against 0.684 for the best threshold available.

The ceiling on the actionable bands moved from 49 to 39, and it is placed by the false-positive budget
rather than by separation: 3.8% of legitimate domains fall below 40, inside the 5% rate `1.1.0` and `1.2.0`
both shipped. The `high_risk` ceiling moved from 24 to 18, which is exactly where it stops taking more than
2% of legitimate domains; this is the one boundary where being wrong means blocking somebody real, so it
takes the measured limit rather than a margin past it. The `established` floor moved from 80 to 70, three
points above the lowest floor that still holds abuse under 2% of its class.

The lower edge of `unclear` is no longer pinned to the neutral base of 50. What that pin protected still
holds, since a domain with no evidence either way scores 50 and lands in `unclear` by construction, but
the edge is now placed by the false-positive budget, because a scale with less positive evidence available
puts ordinary domains below the base without that being evidence against them. `unclear` is correspondingly
wide, and that is the honest result rather than a defect: the model deleted the evidence it had been using
to be confident about legitimate domains, so it now says "I don't know" about 22% of them instead of 2.8%.
The band that says so is where that uncertainty belongs. The measured sweep is in `docs/CALIBRATION.md`.

Confidence under 40 overrides the band with `insufficient_evidence`.

## Confidence coverage weights

Confidence is the share of the applicable weight that answered, so these are relative and need not sum
to any particular total. Registration counts as covered only when a creation date was actually published,
not merely because a registry replied: several answer in full while publishing no date at all, and
counting those would report confidence in an age the model does not have.

| Dimension group | Weight |
| --- | --- |
| Registration (RDAP or WHOIS) | 30 |
| Mail and DNS | 25 |
| Signup capability | 20 |
| Site | 10 |
| Pricing | 10 |

The reputation source is deliberately absent from this table. Confidence is coverage of the evidence the
verdict rests on, and this is the one source that can go dark partway through a month with every other
upstream healthy, because it is metered. Given a weight, an exhausted allowance would drag every domain
analysed afterwards toward `insufficient_evidence`, turning a billing event into a verdict about domains
it says nothing about. Its status is reported in the source panel regardless, and the score already
reflects exactly what it did or did not contribute.

## Stated limitation

The tool reports that a domain is *structurally* risky far better than it reports that a domain is
*known* bad, so a domain that is perfectly configured but already burned in someone's threat feed can
still score well here. The optional reputation lookup narrows that gap without closing it: it is one
signal in one dimension, it carries no weight in confidence, and it is absent entirely from a deployment
without an API key. Consumers holding their own blocklist should treat this score as an independent
signal to combine with it, not a replacement.

## Calibration

Weights are verified against a held-out labelled benchmark. No table, list or fingerprint in the source is
derived from it; two scalars and the band edges are, under a cross-validation protocol that
`docs/CALIBRATION.md` states in full alongside the measured separation and the changes it justified.

The reference false-positive case is a legitimate low-traffic small business more than a decade old
with no DMARC, no DNSSEC and no SaaS verification records. It must land in the established band, which
is what forced the correlated-absence discount group and the rule that absent hygiene records are never
penalised alone. It survived `1.3.0` almost untouched, at 86 against 88, which is the useful thing about
having chosen it: the credits withdrawn there were ones this domain never had. What the change cost was
concentrated on well-resourced legitimate organisations, which had the most headroom to lose.

## What was built, measured and dropped

Several capabilities were built, measured against the labelled holdout, and then taken out again before
this model shipped. The evidence is kept here rather than discarded with the code, because a reader
proposing any of them is proposing something that has already been tried, and the measurement is the
only thing that says why it did not work.

That claim is worth what the measurement behind it is worth, and every figure in the entries below was
originally taken when the legitimate group held 62 domains. In `1.2.0` each removal that the stored responses
could still answer was re-measured against 4,415 abuse and 212 legitimate domains, by defining the retired
signal again in the audit script and scoring it through the real clamps, discounts, combinations and bands.
Fifteen of the sixteen were upheld; the one exception is recorded in its own entry. Where an entry below
gives two figures, the second is that re-measurement, and it says what reinstating the signal would have
been worth on the enlarged holdout rather than what it was worth in `1.0.0`.

**That harness has since been deleted, so these are a record rather than something the current audit
reproduces.** Keeping it meant keeping a definition of every retired signal one import away from the live
set, which is a signal somebody eventually makes live by accident, and re-running it was answering a
question already answered. Certificate transparency and the web archive were never testable this way in
any case, because they were removed as *sources* and no stored transcript contains them. Re-testing any of
this now means writing the signal again against the same holdout, which is what was done the first time.

**Off-domain redirect penalty (`site.redirect_off_domain`).** Penalised an apex that immediately
forwarded elsewhere. Measured when the legitimate group held 62 domains, it fired on 11 of them against
15 of 1,007 abuse ones, eleven times the rate on the class it was meant to exonerate, and removing it
raised abuse-versus-legitimate AUC from 0.921 to 0.931 while returning nine legitimate domains to a
legitimate band at no cost to recall. Classifying the destination narrowed it without fixing it, because
the premise was wrong rather than the exclusion list incomplete: pointing an apex at a platform, a booking
page or a social profile is ordinary for a small business with no reason to run a web host, and no
partition of destinations separated the populations. The classification survives the signal — it still
routes known parking targets to `site.parked`, and a redirect still withholds the content credit, since a
root that forwards elsewhere never serves the page itself.

Re-measured in `1.2.0` the case is stronger, not weaker. On the full legitimate group it fires on 13% of
legitimate domains against 1% of abuse, and reinstating it would cost 0.007 of AUC and put ten further
legitimate domains into an actionable band to recover four abuse ones. The classified variant, restricted
to destinations that could not be placed, is indistinguishable from the unrestricted one on every figure.

**Presence of inbound mail (`mail.mx_present`).** Paid `+2` for having MX records at all, on the grounds
that configuring mail is a deliberate act of setup. The argument does not survive the threat model. An
account farmer has to receive the verification or OTP message, so working inbound mail is a
*precondition* of the abuse this tool exists to detect, and the model already refused to penalise its
absence for exactly that reason. Paying for its presence is the same claim with the sign reversed, and it
cannot be right in both directions.

The measurement agrees that it was doing nothing: it fired on 83% of abuse against 97% of legitimate
domains, worth 0.28 points of separation and +0.001 AUC. The small separation it did have was not
measuring what the signal claimed. It tracked *dead* domains rather than non-farms, since a quarter of the
abuse group has no mail configured at all, so what earned the points was mostly the absence of mail on
domains that had already stopped working, not the presence of mail on real businesses.

Removing it cost 0.001 AUC, moved the band floor from 58 to 55, and pushed two legitimate domains from
`unclear` into `suspicious`, taking the false-positive rate from 4.2% to 5.2%. That cost is the reason
this entry records the argument rather than only the number: a signal can be mildly load-bearing on a
cohort and still be reasoning backwards, and this one is kept out on the strength of the threat model
with the measurement showing the price rather than hiding it.

Whether a domain can receive mail is still read as a fact wherever a conjunction needs it. The farm
profile and the parked-with-mail combination both still require it, and both fire at exactly the rates
they did before, since those combinations were always about the pairing rather than about mail alone.

This is the one candidate of the sixteen that the `1.2.0` re-measurement did not uphold, and the
disagreement is worth stating plainly. Reinstating it would improve AUC, by +0.000 with an interval that
sits entirely at or above zero, so on ranking alone the signal is defensible. On verdicts it is not: it
would recover no legitimate domain from an actionable band and send 61 abuse domains into a legitimate
one, which is the largest verdict cost of any candidate tested and the direct consequence of a flat credit
paid, on the enlarged holdout, to 97% of legitimate domains and 84% of abuse ones alike — the same
near-universal credit the 62-domain measurement above put at 83%. The original entry kept it out on the
threat model while recording that the measurement disagreed; the enlarged holdout now has the argument and
the shipped metric on the same side, and only the ranking metric against.

**Character-shape name signals (`name.high_entropy`, `name.many_hyphens`).** Neither could fire at its
configured threshold: per-character entropy peaked at 3.83 bits against a threshold of 4.0, and no label
in 702 domains carried more than 2 hyphens against a threshold of 3. They were deleted rather than
retuned because the measurement showed the heuristic pointing the wrong way. Per-character entropy is
maximised by long labels drawing on many distinct characters, which describes a descriptive brand name
at least as well as a generated one: at a threshold of 3.0 it selects 40% of legitimate domains against
14% of abuse. Hyphen counting has the same defect in weaker form, and the one time it fired at all was
on a legitimate 30-character label. Separating a generated name from a chosen one needs a model of what
a pronounceable name looks like, which a character histogram is not, so the capability is gone rather
than weakened. The name clamp is -5 rather than -8 to match the only negative left in the dimension.

"It could not fire at the value we picked" is a weaker claim than this section wants to make, so `1.2.0`
swept both across every threshold instead of re-testing the configured one. The stronger claim holds. On
4,417 abuse domains, entropy still never reaches 4.0 and no label carries three hyphens, and at every
threshold low enough to fire at all the signal selects legitimate domains ahead of abuse — 62% against 45%
at 2.6 bits, 35% against 18% at 3.0, 19% against 7% at 3.2 — with a negative ΔAUC throughout and an
interval excluding zero everywhere between 2.6 and 3.2. The single-hyphen threshold behaves the same way,
at 8% of legitimate domains against 2% of abuse. There is no threshold at which either heuristic works.

**Certificate transparency and the web archive**, along with the certificate name-breadth signal, the
drop-catch override and the age-corroboration confidence weight that depended on them. Both sources
could only ever raise a lower bound on age rather than establish it, and the archive index usually timed
out. `firstSeen` is the registration date alone as a result. Restoring coverage for the suffixes that
publish no RDAP was answered by reading the registration record over port 43 instead, which gives a real
creation date rather than a bound. See `docs/SOURCES.md`.

**Parent-suffix price inheritance.** A suffix absent from the price list used to inherit its parent's
price. That was wrong in the direction that hides abuse: `web.id` was read as an $18 registration when
it retails near $2, which zeroed the price penalty and asserted a renewal ratio of 1.0 that nothing had
measured. Absence is now reported as a neutral note. Backfilling the missing prices from other feeds was
rejected rather than attempted; see `docs/SOURCES.md`.

Re-measured in `1.2.0` the inheritance reaches only four families across the whole holdout and changes no
verdict, so the enlarged dataset neither strengthens nor weakens the case. The removal stands on the
correctness argument it was always made on, and this entry records that the measurement has nothing to add
rather than implying it agreed.

**Cohort detection** was never built, because it requires persistent cross-request state and the service
is stateless. What replaced it is the set of stateless DNS-derived capabilities the model does carry:
DKIM probing through one CNAME hop, whose *absence* `combo.inbound_without_outbound` reads as one third of
its conjunction, and the registrar-default conjunction, which requires registrar identity, default
nameservers, bundled forwarding, youth and no substantive site to agree before any of them counts. This
list was longer. Website CNAMEs classified into paid custom-domain products and generic hosting went in
`1.2.0`, and the autodiscovery, enrollment, SIP and calendaring records went in `1.3.0`, each with the
credit that read it and the queries that fed it.

### Dropped in 1.2.0, on the enlarged holdout

The seven below were in the shipping model until the signal audit was rerun against 4,415 abuse and 212
legitimate domains with intervals attached. Each was removed on positive evidence of no value or of harm,
never on a failure to measure it; a signal too rare to judge is recorded as unmeasured and kept. Every
figure is family-weighted, so one operator's several hundred generated names count once.

| Removed | Measured | Why |
| --- | --- | --- |
| `signup.relay_domain`, -12 | 12 families, none abuse, separation -0.08 | The model's stated policy is that alias capability is flagged and not condemned, and a penalty is condemnation. It only ever cost legitimate domains points. The `forwarder` flag is derived from the facts and is unaffected. |
| `economics.free_subdomain`, -12 | 46 families, lift interval spanning 1.00, no verdict changed | Flat. The reasoning survives where it was always doing the work, in `combo.farm_profile`, which now reads the free-subdomain fact directly. |
| `economics.vetted_suffix`, +4 | Fires on the same domains as `name.vetted_suffix`, 100% agreement | One fact scored in two dimensions, clearing both clamps instead of one. Now paid once, in the name dimension. |
| `age.long_term`, +5 | 41 families; removal took 10 abuse domains out of a legitimate band at no cost | Bulk registrars discount multi-year terms, so paying years ahead is as available to someone buying a hundred names as to someone buying one. |
| `configuration.public_registrant`, +3 | 58 families; removal took 2 abuse domains out of a legitimate band at no cost | Redaction is now close to universal among the small businesses this rewarded, so the unredacted population is no longer the population the reasoning assumed. |
| `configuration.hosted_service`, +4/+2 | 11 families, on more legitimate domains than abuse, no interval either way | Barely reachable, and dependent on DNS fingerprints that stop matching silently when a platform changes its custom-domain target. It was the only reader of the platform table and the apex CNAME lookup, so this removal retires a second network request. |
| `site.robots_txt`, +2 | 721 families, 19% of abuse against 26% of legitimate, lift interval reaching 1.00; removal took 24 abuse domains out of a legitimate band at no cost | Parking pages and bulk hosting templates ship a robots file by default, so it measures the hosting stack rather than intent. This one also retired a network probe: the site collector no longer requests the file. |

### Dropped in 1.3.0, on the verification rule rather than on a measurement

The nine below were removed on a different basis from everything above them, and the difference is worth
stating because it changes what the measurement means. Every earlier removal was made because the holdout
showed the signal was flat, redundant or backwards. These were removed because they are **unverifiable**:
each is a string the domain publishes in its own zone, nothing in the model checked it against the party
it names, and so each was free for an account farmer to mint. On the holdout most of them measured
*useful*, and they were removed anyway.

| Removed | Was | Why it cannot be verified |
| --- | --- | --- |
| `footprint.saas_vendors` | +12 | The census matches a TXT prefix. No vendor publishes any way to confirm a token it issued, so an invented string counts the same as a real one and five of them reached the top tier. |
| `mail.bimi` | +8 | The rationale priced a purchased Verified Mark Certificate; the collector checked that a record began with `v=BIMI1`. Confirming it means fetching the certificate and checking its issuer against a Mark Verifying Authority, which is a network request for a signal already below the audit's rarity gate. |
| `footprint.business_services` | up to +6 | A CNAME pointing at a vendor requires no account with that vendor, and `_caldav._tcp` and `_sip._tls` were credited for pointing anywhere at all. |
| `footprint.dkim` | +4 | Only the DNS half of signing is observable and that half is free: generating a keypair and publishing the public half is one command, and nothing establishes that a message was ever signed with it. |
| `mail.paid_spf_senders` | +3 | An SPF `include:` is a string. The platform is not consulted, and authorising a sender you have no account with costs nothing and breaks nothing. |
| `mail.strict_alignment` | +3 | Two characters in a record the domain writes about itself. The claim was that strict alignment breaks undeliberate mail, but a domain that never sends breaks nothing by requiring it. |
| `mail.dmarc_policy` | +1 / +3 | The model already said abusers publish `p=reject` because it is free and looks reputable. The weight contradicted its own rationale. |
| `mail.subdomain_policy` | +2 | One more tag in the same record. |
| `mail.spf_present` | +2 | Near-universal, free, and self-asserted. |

Seven of the nine are still collected and reported at zero, because each rides along in a record the
service fetches anyway: SPF and the vendor census come out of the apex TXT set, and the DMARC tags all
come out of one `_dmarc` lookup. The audit gives them their own tier, `KEEP scores zero by design`, so
that a signal deliberately paying nothing is never mistaken for one the run failed to observe.

Two do not, and those two were deleted outright rather than zeroed, on the same reasoning that retired the
`robots.txt` probe above. BIMI had a TXT lookup of its own at `default._bimi`, and business services had
six queries of their own — `autodiscover`, `enterpriseenrollment`, `enterpriseregistration` and three SRV
records. Reporting a fact the model is indifferent to is not worth a round trip, so the queries, the
`businessServices` and `bimi` facts, and the vendor fingerprint table behind the former all went with the
credits. Together they were a third of all DNS work: 21.7 queries per analysis down to a projected 14.6,
and 14.7 as since measured on transcripts the new collectors produced. That table had also been quietly
failing — `enterpriseregistration.windows.net` is what that probe returns and it matched no pattern in the
table, so 36 of 4,760 transcripts were paying for an answer the classifier discarded.

Also trimmed rather than removed: `configuration.record_breadth` no longer counts SPF, DKIM, vendor
verification or business-service records among its classes. Three of those four were simultaneously
earning their own credits in `footprint`, so one set of invented records was clearing two dimension
clamps.

Kept, and now the only credit in the mail dimension: `mail.commercial_rua`, because RFC 7489 §7.1 makes
it the one part of a DMARC policy a third party has to agree to. It is paid on the vendor publishing the
authorisation record, not on the domain naming a vendor.

It is also the one signal here that no stored transcript could measure, since the lookup it depends on
postdated all of them, so a re-collection is what finally priced it. Twelve domains in the holdout name a
commercial reporting vendor and the vendor vouched for all twelve. It fires on 5% of legitimate domains
and 0% of abuse ones across 12 families, with a conditional lift interval of 0.05 to 0.48 that sits
entirely below 1.00, which is the interval saying it selects legitimate domains rather than merely failing
to select abuse. Twelve domains cannot move a ranking metric over 4,627, so its ΔAUC is +0.000 and will
stay there; what it establishes is that the verification works and that nothing has to be taken on the
domain's word to pay it.

**What this cost, measured rather than asserted.** Family-weighted AUC fell from 0.944 to 0.933 on the
collection the two versions shared. The holdout is 4,415 abuse domains collected in the wild that never
optimised against this scorer, so on that population the self-asserted credits genuinely did discriminate,
and by a wide margin: 67% of legitimate domains publish DMARC against 11% of abuse, 43% publish a DKIM key
against 7%, and 44% carry a vendor verification token against 10%. That gap is real and it is now unpaid.

It is also exactly the property an adversary removes for free, since every record in it costs a few
minutes in a DNS console. No ablation against a static holdout can see that, which is why the rule here is
a correctness argument with the price recorded beside it rather than a measurement.

On the verdicts the service actually ships, and after the bands were re-seated to the new distribution,
the trade is better than the AUC suggests: false positives fell from 5.2% to 3.8%, and abuse reaching a
legitimate band from 10.1% to 5.8%. What was bought with the AUC is the fake-resistance; what it cost is
confidence about legitimate domains, which now land in `unclear` 22% of the time against 2.8% before.

Re-collecting the whole holdout under the `1.3.0` collectors recovered part of the AUC as well, to 0.939,
which is a property of the evidence rather than of the model: the port-43 registration lookup added a real
creation date for 192 domains, and age is the heaviest dimension there is. `docs/CALIBRATION.md` separates
the two effects by scoring the identical model against both collections.

The fixture pair `modestNewBusiness` and `selfAssertedRecords` pins the result. Under the `1.2.0` weights,
publishing the full set of free records moved a 60-day-old `.com` from 51 to 83, out of `unclear` and into
`established`. Under `1.3.0` the same records move it by zero.

Two more findings are measured and deliberately **not** acted on.

The site dimension as a whole still ablates negative, at -0.003 AUC, but the interval now spans zero. The
case has weakened at every enlargement: -0.021 when the legitimate group held 62 domains, -0.005 at 212
with each family counted once, and -0.003 with an interval of -0.008 to +0.001 on the fresh collection.
That is the trajectory of a small-sample artefact rather than a dimension pulling the wrong way. It is also
kept because these ablations are measured on the same cohort the weights were tuned against, so they
establish that a dimension is not earning its place *here* rather than that removing it generalises. See
`docs/CALIBRATION.md`.

`site.parked` is the clearest case of the two metrics disagreeing, and the disagreement is left standing
rather than resolved quietly. It fires on much the same share of legitimate domains as abuse ones and
removing it would raise AUC by 0.003, but it is holding 18 abuse domains out of a legitimate band for the
price of 2 legitimate domains in an actionable one. AUC ranks and the service ships bands, so the bands
decide. The audit prints such cases as `KEEP bands disagree` rather than hiding them behind whichever
number was consulted first, and three signals currently carry that tier.

## Changelog

### 1.4.0

Added `signup.checkmail`, one signal reading a third-party reputation verdict from Check-Mail.org. It
closes the one gap the rest of the model cannot reach by construction: every other signal reads what a
domain publishes about itself, and a name registered an hour ago by an operator who has already burned a
thousand others publishes exactly what an innocent new name publishes. It is optional, gated on
`CHECKMAIL_API_KEY`, and absent from a deployment without one.

This release reverses two stated positions, and both are worth naming rather than quietly amending.

**"No third-party reputation lookups at all"** was narrowed to no third-party reputation *feeds*. The
rejection had been reasoned about bulk lists, whose staleness and download cost are real and still
disqualifying; a single point lookup has neither problem. `docs/SOURCES.md` records the full argument.

**"Penalise only on positive evidence"** now has exactly one exception, bounded to a single point: a
clean reputation answer credits `+1`. The alternative was scoring zero, which renders in a collapsed
section and leaves a reader unable to tell a domain the vendor cleared from one it was never asked
about. The cost, stated plainly: the credit lands mainly on domains no feed has caught yet, which is the
population this model exists to find, and a domain analysed after the monthly allowance is spent scores
a point below the same domain analysed the day before. One point cannot move a band, and a test pins
that it never does.

`clamps.signup.max` moved from 6 to 7, so a paid tenant and a clean answer stay additive rather than the
credit being clamped into invisibility on exactly the domains most likely to earn both. The disposable
verdict is priced by reading `signup.tempMail` rather than by a number of its own, since it is the same
claim from a source that checks more than the MX fingerprint. That has one consequence worth watching: a
`free_routing` domain the vendor also calls disposable now lands at the -40 floor where it previously sat
at -21, which is an unmeasured signal changing the effective reach of a measured one.

Not measured, and unmeasurable as currently built. The source is metered at 1,000 lookups a month
against a holdout of several thousand domains, so `lib/analyze.ts` excludes it from every recorded and
replayed run and the audit reports it as `KEEP no data, source never answered`. Its weights are the only
ones in the model placed by judgement rather than by a sweep. It also carries no confidence weight, so
an exhausted allowance cannot move a verdict; and because the credit never fires under replay, reported
calibration distributions sit one point below what the deployed service emits.

### 1.3.0

Applied one rule across the signal set: a credit is paid only where somebody other than the domain
confirms it. Nine credits worth 44 points together were reduced to zero because nothing can confirm them,
and `configuration.record_breadth` was trimmed to the record classes that have to point at a host. They
are `mail.spf_present`, `mail.dmarc_policy`, `mail.strict_alignment`, `mail.subdomain_policy`,
`mail.paid_spf_senders`, `mail.bimi`, `footprint.saas_vendors`, `footprint.dkim` and
`footprint.business_services`. Seven are still collected and still reported without moving a score, because
each rides along in a record fetched for another reason.

`mail.bimi` and `footprint.business_services` were deleted rather than zeroed, because each owned the DNS
queries that fed it and a fact nothing weighs does not justify a round trip on every analysis. Gone with
them: the `default._bimi` lookup, the six business-service probes, the `bimi` and `businessServices` facts
and the vendor fingerprint table. DNS work per analysis falls by a third, from 21.7 queries to 14.6.
`www` also stopped being queried twice, and the DKIM selector list was cut from eight names to the six
that reach 98.8% of detections.

Added the one verification that is cheap: `mail.commercial_rua` is now paid on the RFC 7489 §7.1
authorisation record the vendor must publish at `<domain>._report._dmarc.<vendor>`, rather than on the
domain naming a vendor. This is one DNS query, and only where a commercial vendor was matched. A vendor
that has not vouched for the domain scores zero, and so does a query the resolver could not answer,
because silence is not a refusal.

Two dimension clamps moved to match what their signals can now reach, `mail` to +4 and `footprint` to +3.
Three of the four band edges moved to follow the distribution the removals shifted: the actionable ceiling
from 49 to 39, `high_risk` from 24 to 18 and the `established` floor from 80 to 70. The
`probably_legitimate` floor stayed at 55. The lower edge of `unclear` is no longer pinned to the neutral
base; the reasoning is above.

Fixed a parsing bug the audit could not have caught: a DKIM selector was accepted on any record containing
the substring `p=`, which matches an SPF mechanism and a good deal of prose. It now requires the RFC 6376
grammar, with an empty `p=` correctly read as a revoked key.

Re-collected the whole holdout, since two of the changes above alter what is requested and no stored
transcript predating them could measure either. That is what put a number on `mail.commercial_rua` for the
first time — twelve domains name a commercial vendor and all twelve vendors published the authorisation
record — and what let the port-43 lookup be measured, at a creation date recovered for 192 of the 269
domains whose suffix publishes no RDAP at all.

Measured cost, on 4,415 abuse and 212 legitimate domains: AUC 0.944 to 0.933, false positives 5.2% to
3.8%, abuse in a legitimate band 10.1% to 5.8%, legitimate domains in `unclear` 2.8% to 22%. On the fresh
collection AUC is 0.939, the difference being evidence the older transcripts did not contain rather than
anything the model does differently. The dimensions that survive all ablate higher than before, `age`,
`signup`, `configuration` and `economics` alike, since the withdrawn credits are no longer crowding them.
The 5-fold sweep proposes no further change to any of the six tunable scalars. See `docs/CALIBRATION.md`.

### 1.2.0

Re-ran the signal audit against 4,415 abuse and 212 legitimate domains, family-weighted and with bootstrap
intervals on every figure, and removed seven signals and one discount group that the enlarged holdout shows
are flat, redundant or backwards. They are `signup.relay_domain`, `economics.free_subdomain`,
`economics.vetted_suffix`, `age.long_term`, `configuration.public_registrant`,
`configuration.hosted_service`, `site.robots_txt` and the cheap-price-plus-high-renewal discount. Each
entry above carries the measurement it was removed on. Two dimension clamps moved to match what their
signals can now reach: economics to a maximum of 0, since nothing in it can score positive any more, and
site to +6.

Corrected two entries in the vetted-suffix list, `edu.pl` and `edu.eu.org`, which were not gated by
accreditation. The largest credit in the model was mostly firing on them, which had made a working signal
read as harmful.

Retired two network requests along with the signals that read them: the site collector no longer requests
`robots.txt`, and the DNS collector no longer queries the apex `CNAME`. Removing a signal and leaving its
probe behind would keep the cost while dropping the reason for it.

Tuned two values under 5-fold cross-validation stratified over families, each judged only on the families
its fold had not seen. `signup.freeRouting` moved from -18 to -21, and the `configuration` clamp maximum
from 12 to 10. All five folds picked both, and each recovers the equivalent of twelve abuse families from
a legitimate band without admitting one further legitimate domain to an actionable one. The other four
knobs swept were left where they were. The clamp change is second-order and only became visible after the
first: it was proposed by the sweep on the rerun, which is the reason to run the sweep to a fixed point
rather than once.

Re-checked all four band edges against the enlarged holdout and left all four where they are. The
`probably_legitimate` floor of 55 is still the best separating threshold available, at a Youden J of 0.819
against 0.814 for its nearest neighbour, and the two edges that had never been measured at all both come
back within three points of where they were placed by hand.

### 1.1.0

Removed `mail.mx_present`. Presence of inbound mail now scores nothing in either direction, matching the
existing rule that its absence is never penalised: an account farmer must receive the verification
message, so mail is a precondition of the abuse rather than evidence about it.

The `probably_legitimate` floor moved from 58 to 55, following the distribution the removal shifted down.
The measured cost is 0.001 of AUC, at 0.942, and one point of false-positive rate, at 5.2%, from two
legitimate domains that lost the `+2` holding them above the `suspicious` ceiling.

### 1.0.0

Initial model.
