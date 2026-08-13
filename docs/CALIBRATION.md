# Calibration

Every figure below comes from a single collection of the whole holdout on 13 August 2026 and the two
offline runs over it described under "Reproducing", so all of them are reproducible from the same
stored responses. **The model was at `1.3.0` when that collection was scored; the current model is
`1.4.0`.** This document is therefore a dated report rather than a description of what ships, and it is
not rewritten in place when the model moves — a measurement is only meaningful with the version it was
taken against. Regenerate it with `npm run audit` when the numbers need to be current.

Three things have changed since, none of them priced here:

- **`signup.checkmail`**, added in `1.4.0`, is unmeasurable against this holdout by construction. The
  section "One signal is unmeasurable by construction" below sets out why and what it costs.
- **The port-43 lookup has been widened** to run wherever RDAP produced no answer, rather than only
  where a suffix publishes no RDAP service at all, so the registration coverage below is what the
  narrower trigger achieved. See `docs/SOURCES.md`.
- **The eight zero-weight signals became observations** in `1.4.0`. They scored nothing then and score
  nothing now; what changed is that they are no longer in the registry the audit iterates, so a rerun
  will report 23 signals rather than 31 and the "zero by design" tier will be empty of them. Nothing
  about the measured separation moves, because a signal contributing zero points contributed zero to
  every figure in this document. See `lib/scoring/observations.ts`.

## The holdout

The dataset is three grouped files, held locally and deliberately not committed:

| File | Rows | Graded as |
| --- | --- | --- |
| `benchmark/abuse.csv` | 4,417 — 4,294 `ABUSE`, 123 `DISPOSABLE` | Abuse |
| `benchmark/legitimate.csv` | 223 | Legitimate |
| `benchmark/privacy.csv` | 58 | Not graded |

The file a domain sits in decides how it is graded; the `classification` column inside it is the finer
label, which only splits a group for reporting. `abuse.csv` carrying both `ABUSE` and `DISPOSABLE` rows
is one graded class reported as two, not a labelling error.

Every row has a stored response, where at `1.1.0` only about a quarter of the abuse group did. That
matters more than the headline figures, because the signals the collection was run for are the rare ones,
and a signal cannot be told apart from a worthless one until it has fired somewhere.

### What the holdout is allowed to decide

`1.1.0` claimed that nothing in `lib/` was derived from this data. That claim stopped being true the
moment a threshold was adopted from a sweep against it, so it is replaced here with a precise account of
what the dataset has touched. Three categories, with different rules:

**Derived from the holdout, under cross-validation.** Two scalars and four band edges. `signup.freeRouting`
at -21 and `clamps.configuration.max` at 10 were each picked by a 5-fold sweep stratified over families,
adopted only because all five folds agreed and the value held on the families their fold had not seen. The
band edges are positioned on the measured crossover and, for three of the four, on the false-positive
budget. Everything in this category is a number chosen from a small candidate set, which is the kind of
fitting a fold protocol can bound.

**Removed because of the holdout.** Seven signals and one discount group in `1.2.0`, on top of the six
capabilities removed earlier. Deletion is the direction of this dataset's influence that carries the least
overfitting risk, since it can only reduce the number of things fitted, and the rule deletes only on
positive evidence of no value.

**Removed in spite of the holdout.** The nine self-asserted credits withdrawn in `1.3.0`. This is a
category the earlier versions of this document did not need, and it is the one to read most carefully,
because the dataset argued *against* every one of these removals. They were made on a property the holdout
cannot measure: a credit nothing can verify is free for an adversary to mint, and an adversary who has not
yet bothered leaves a dataset in which the credit still looks predictive. The price is recorded in full
under "Measured separation" rather than argued away.

**Not derived from the holdout at all.** Every provider list, MX fingerprint, nameserver pattern, vetted
suffix and price in `lib/data/`, and every point value not named above. These come from public provider
documentation and a published price snapshot. The single case where the holdout touched one of them was a
correction rather than a fit: two entries in the vetted-suffix list did not meet the list's own stated
criterion, and the audit is what made that visible. Both were removed on the criterion, not on their
scores.

The protocol matters because the folds are the only thing standing between tuning and memorisation. Folds
are stratified over *families* rather than domains: the abuse half contains generated groups of hundreds
of names differing by a counter, so splitting by domain would put near-identical siblings on both sides of
the split and report memorisation as generalisation. The holdout holds 3,496 abuse families and 212
legitimate ones, and the largest single family contributes 99 names. Every statistic in this document
weights each family to a total of one for the same reason, and every interval resamples families rather
than domains.

### Privacy domains are reported but never graded

A privacy or forwarding service is a legitimate product that also happens to be ideal for minting
accounts. The model's position is to flag that capability and leave the policy to the consumer, so
grading these domains either way would measure a decision the model deliberately refuses to make:
counting them as abuse would score it against a ruling it does not issue, and counting them as
legitimate would reward it for missing the exact capability it exists to detect.

They are therefore excluded from AUC, from the false-positive count and from the false-negative count,
while their distribution is still printed. Where they fall relative to the two graded groups is the
useful part, and it is not an error rate in either direction:

| Where privacy domains land | Share of 58 |
| --- | --- |
| Risk band | 72% |
| Unclear | 14% |
| Legitimate band | 14% |

The spread is the expected shape. A forwarder is flagged for its capability, and the rest of its
configuration then decides the verdict like any other domain.

## Reproducing

```bash
npm run audit -- --collect    # probes the network once, storing facts and the responses behind them
npm run audit -- --reparse    # rebuilds the facts from those responses, no network
npm run audit                 # per-signal tiers, ablations and sweeps, no network
npm run calibrate             # distributions, band edges and error cases, no network
```

Only the first command touches the network, and it is resumable: a re-run probes whatever is not already
stored, which is what makes it safe to interrupt. It does not touch the metered reputation source under
any flag, and needs no opt-out to avoid it: `lib/analyze.ts` gates that collector on whether a recording
or replay context is active, so all four commands above are structurally incapable of spending the
monthly allowance. This is deliberately not an environment variable — the whole point is that a
collection run cannot burn a month's quota by someone forgetting one. The second looks redundant and is
not; see "Stored responses" below. Both reports then read the whole holdout with no sampling — the
family weighting is what stops one operator's several hundred generated names dominating a figure, so
there is nothing to cap.

The last two are one script, and `npm run calibrate` is `signal-audit --bands`. It was a script of its
own until `1.4.0`, and the merge removed a way for the two reports to disagree rather than just a file:
it replayed the stored transcripts through `analyze` while the audit scored the stored *facts*, so
running them out of order gave each a different view of one collection. Both now read the same facts.

Topping up one group without probing the others is what `--group` is for:

```bash
npm run audit -- --collect --group legitimate
```

## Stored responses

Probing the holdout is the only expensive part of either script, so every response is written to
`.audit-cache/raw/` as it arrives, before anything parses it. That store is what makes a re-measurement
cheap, and it is the reason a collector change does not cost a full recollection.

Which command a change calls for follows from where the change is. A weight or band moves nothing that was
observed, so it needs only a re-score. A collector or parser reads the same responses differently, so it
needs `--reparse`. Only a change to *what is requested* needs the network again.

`--reparse` immediately after a collection is not redundant, which is the part that is easy to get wrong.
A collection writes the facts its deadlines allowed: where a collector was still waiting when the 15-second
budget fired, the domain is stored without that evidence. Replay answers instantly and gets further, so a
re-parse produces slightly *more* complete facts than the collection that fed it. Running it promotes the
whole store to what the responses actually support, which is the state every figure in this document is
measured against.

Until `1.4.0` this also decided whether the two reports agreed with each other, because one replayed and
one scored facts. That failure mode is gone: both read the facts, so `--reparse` now affects only how
complete those facts are, and it affects both identically.

The store is gitignored along with the rest of `.audit-cache`, holds bodies capped at 256 KB, and is
gzipped. The full holdout occupies 31 MB across 4,699 transcripts, about 4.6 KB each, down from 32 MB and
7 KB at `1.2.0` because `1.3.0` retired a third of the DNS work. That reduction was projected at the time
as 21.7 queries per analysis falling to 14.6, by subtracting the retired probes from stored transcripts;
measured directly on transcripts the new collectors actually produced, it is 14.7. Reference data that
every domain shares, meaning the IANA bootstrap, is recorded once in `_shared.json.gz` rather than in each
transcript.

Two things a replayed run cannot recover, both reported rather than papered over:

- **A request the recording never saw** has no answer. Rather than quietly fetching it, replay counts it
  as a miss, because a stale transcript silently topped up from the network would look like a complete
  one. On this collection that is 8 requests across 4,698 domains. Nearly all misses are requests a
  collector's deadline abandoned before anything came back to record, so a re-parse run immediately after
  collecting, which answers instantly and gets further, reaches almost none of them.
- **Anything measured against the clock** is measured from today. Registration age is the one that
  matters: replaying a month-old transcript ages every domain in it by a month, which is why the run
  prints how old the oldest recording is.

### What the collection cost, and what it recovered

The whole holdout took 19 minutes at a concurrency of 8. Throttling was effectively absent, at 19 of 4,415
domains on RDAP and 3 on WHOIS, against a `1.2.0` collection whose RDAP success fell from 87% to 65% as it
scaled and needed a repair pass at a concurrency of 4 to reach 68%. Retiring a third of the DNS work is
most of that difference, and it is why `--repair` no longer exists: what it was built to recover no longer
happens at this size.

Registration coverage is the figure the model most depends on, and it now has two sources:

| | Domains | Share |
| --- | --- | --- |
| RDAP answered | 2,986 | 64% |
| RDAP timed out | — | 23% |
| Suffix publishes no RDAP | 269 | 6% |
| WHOIS answered | 224 | 5% |
| **Creation date established** | **3,175** | **68%** |

These are outcomes rather than a partition, and the last row is deliberately not the sum of the two that
answered. 224 domains got a WHOIS answer but only 192 of those answers carried a creation date, and three
RDAP answers carried none either: 35 registries in total replied in full while publishing no date, which
is the DENIC, nic.at and EURid case that `docs/SCORING.md` describes.

The port-43 collector is measured here for the first time, and it does what it was added for: of the 269
domains whose suffix publishes no RDAP service at all, it recovered a real creation date for 192, or 71%.
That slice is now nearly closed. On the `1.2.0` collection the same collector reported `unavailable` on
every domain it was asked about, because no transcript from that era contains a port-43 exchange for it to
replay — which is what a re-collection was needed to fix, and the reason this row could not be reported
before.

Total coverage barely moved, at 68% then and 68% now, but its composition did. RDAP answered four points
less often on this run, which is ordinary day-to-day variance in how quickly registries reply, and port 43
more than covered the difference. Those are independent failure modes, so the model is less exposed to
either one than the flat total suggests.

What is left is a property of the population rather than of the run. A third of the holdout still has no
age evidence, and the missingness is not random: abuse domains cluster under registries that are slow to
answer, so the source carrying the model's strongest signal is also the one most likely to be missing
exactly where it would matter most. The model already treats this correctly, by scoring age only when it
has a registration date rather than approximating one, but this remains the single largest gap in the
measurement. It is now a timeout problem rather than a coverage one, which is the kind a slower run
fixes — and, since this collection was taken, the kind the widened port-43 trigger is meant to fix
outright. Whether it does is unmeasured until the holdout is collected again.

## Measured separation

Scoring `legitimacy`, where higher is more legitimate:

| Label | Group | n | median | mean | p10 | p90 |
| --- | --- | --- | --- | --- | --- | --- |
| `ABUSE` | Abuse | 4,292 | 21 | 25.9 | 0 | 53 |
| `DISPOSABLE` | Abuse | 123 | 15 | 18.9 | 0 | 45 |
| `LEGITIMATE` | Legitimate | 212 | 70 | 67.8 | 46 | 88 |
| `PRIVACY` | Not graded | 58 | 13 | 23.2 | 0 | 66 |

Separation between the abuse and legitimate medians is **49 points**. Ranked by risk,
abuse-versus-legitimate AUC is **0.939**, family-weighted, over 4,415 abuse against 212 legitimate
domains.

Thirteen domains are absent from the table because they were never scored: two abuse rows rejected as
malformed input, and eleven legitimate rows ruled `out_of_scope` as shared free provider vanity domains,
which is the gate working rather than a failure to score them.

### What the fresh collection was worth

The `1.3.0` figures this document carried before were taken by replaying transcripts recorded for
`1.2.0`, which predated two of the changes they were describing. Scoring the identical model against both
collections separates the two effects exactly:

| | Old collection | Fresh collection |
| --- | --- | --- |
| AUC | 0.933 | 0.939 |
| Legitimate domains in an actionable band | 11 (5.2%) | 8 (3.8%) |
| Abuse domains in a legitimate band | 248 (5.6%) | 254 (5.8%) |

The model did not change between those two columns; only what it could see did. The two collections differ
in one large way and one small one — 192 domains gained a registration date from port 43, and 12 gained a
verified reporting vendor — and the first of those is much the likelier explanation, since age is the
heaviest dimension in the model by a factor of six. Which is not the same as having isolated it, and this
document does not claim to have: reproducing the split would mean collecting twice more with the port-43
lookup disabled.

The other thing the fresh collection bought is a signal that could not previously be measured at all.
**`mail.commercial_rua` now scores**, because the `_report._dmarc` authorisation lookup it depends on
postdated every earlier transcript. Twelve domains in the holdout name a commercial reporting vendor, and
the vendor published the RFC 7489 §7.1 record for all twelve. It fires on 5% of legitimate domains and 0%
of abuse ones, across 12 families, with a conditional lift interval of 0.05 to 0.48 — entirely below 1.00,
which is the interval saying it selects legitimate domains rather than merely failing to select abuse.
Its ΔAUC is still +0.000: twelve domains cannot move a ranking metric over 4,627. The mail dimension now
has one live credit rather than none, and it is the only place in the model where a third party is asked
to confirm anything.

### What `1.3.0` cost, and why it was paid anyway

Against `1.2.0`, measured on the collection they shared, AUC fell from 0.944 to 0.933. That is the largest
single regression in any metric this document tracks and it was accepted deliberately, so the reasoning
belongs here next to the number rather than in a footnote.

Both distributions moved down, and by similar amounts, so separation between the medians actually widened.
What worsened is the overlap: the withdrawn credits were doing real discriminating work on *this*
population. The rates are worth stating plainly, because they are the case against the change and it
should be legible: 67% of legitimate domains publish DMARC against 11% of abuse, 43% publish a DKIM key
against 7%, and 44% carry at least one vendor verification token against 10%.

That is precisely the property that does not survive contact with an adversary. Every one of those credits
was free to mint, so the gap they measured is a gap between people who bothered and people who had not yet
been given a reason to. The holdout cannot see that, because a domain collected in the wild was never
competing against this scorer. Measuring fake-resistance needs an adapted population, and no such dataset
exists; what exists is the argument, and the price.

The price on the shipped output is much smaller than on the ranking metric, because bands are not ranks.
After re-seating the edges, false positives fell from 5.2% to 3.8% while abuse reaching a legitimate band
nearly halved, from 10.1% to 5.8%. The whole cost landed on `unclear`, which grew from 2.8% of legitimate
domains to 22.2%.

That last figure is the honest summary of the change. The model deleted the evidence it had been using to
be confident about legitimate domains, and it now declines to rule on a fifth of them rather than ruling
on the strength of records anybody could have typed. A consumer who needs those verdicts back should read
the flags, or supply evidence the domain cannot mint about itself.

## Where the bands sit

Band boundaries are positioned on the measured crossover rather than chosen for roundness. Sweeping the
`probably_legitimate` floor across the two graded distributions:

| Floor | Abuse below it | Legitimate at or above it | Youden J |
| --- | --- | --- | --- |
| 40 | 67.3% | 96.2% | 0.636 |
| 44 | 71.7% | 95.3% | 0.670 |
| 48 | 74.0% | 87.7% | 0.618 |
| 52 | 79.3% | 76.4% | 0.557 |
| **55** | **94.2%** | **74.1%** | **0.683** |
| 56 | 94.6% | 73.6% | 0.682 |
| 60 | 96.1% | 67.5% | 0.635 |
| 64 | 97.0% | 63.7% | 0.606 |

The configured floor of 55 is still where the two distributions cross, at a Youden J of 0.683 against
0.684 for the best available threshold one point below it. The cliff that put it there is still visible:
recall jumps 15 points between 52 and 55.

That this edge did not move is the most informative single fact in this document. It was 58 under `1.0.0`,
followed the distribution to 55 in `1.1.0`, and has now held through a twentyfold increase in the abuse
sample, every removal in `1.2.0`, a change in `1.3.0` that took the top off the legitimate distribution,
and a complete re-collection of the holdout. A boundary that survives that is positioned on something
real.

The other three edges all moved in `1.3.0`, because the legitimate distribution lost its top: its ninetieth
percentile fell from 100 to 88 and its median from 80 to 70. Bands drawn for a scale an ordinary business
could top out on do not fit that, and holding them would have doubled the false-positive rate while
leaving the old `established` floor of 80 reachable by 29% of legitimate domains rather than half of them.

| Band | Range | Of abuse | Of legitimate |
| --- | --- | --- | --- |
| `high_risk` | 0–18 | 39.3% | 1.4% |
| `suspicious` | 19–39 | 28.0% | 2.4% |
| `unclear` | 40–54 | 26.9% | 22.2% |
| `probably_legitimate` | 55–69 | 4.2% | 21.7% |
| `established` | 70–100 | 1.5% | 52.4% |

`high_risk` is configured at exactly 18, which the run confirms is precisely where it stops taking more
than 2% of legitimate domains: the sweep reports 18 as the highest ceiling available and 18 is what is
configured. It takes the measured limit rather than a margin past it because it is the one boundary where
being wrong means blocking somebody real. `established` would need a floor of 67 to hold abuse below 2% of
its own class and is configured at 70, keeping three points of conservatism.

The ceiling on the actionable bands, at 39, is the one edge positioned by the false-positive budget rather
than by separation. 3.8% of legitimate domains fall below 40, which is inside the 5% this model has always
been tuned to, and holding the old ceiling of 49 would have taken far more.

The lower edge of `unclear` is therefore no longer pinned to the neutral base of 50. What the pin
protected still holds — a domain with no evidence either way scores 50 and lands in `unclear` by
construction — but the edge is now fitted, because a scale with less positive evidence available puts
ordinary domains below the base without that being evidence against them.

What the bands produce:

| Outcome | Abuse (n=4,415) | Legitimate (n=212) |
| --- | --- | --- |
| Actionable band (`high_risk` or `suspicious`) | 67.3% | 3.8% |
| `unclear` | 26.9% | 22.2% |
| Legitimate band | 5.7% | 74.1% |

The trade is deliberate. Blocking a real user is the expensive error, so the actionable ceiling is placed
where false positives on legitimate domains stay near or below 5%, which is where every version of this
model has put it. A domain in a legitimate band still carries its flags, which is what a consumer wanting
to be stricter should key on rather than the number.

## Flag precision

Reason codes matter more than the number, because a consumer can act on a reason. Hit rate per label:

| Flag | `ABUSE` | `DISPOSABLE` | `PRIVACY` (not graded) | `LEGITIMATE` |
| --- | --- | --- | --- | --- |
| Catch-all capable | 44% | 64% | 66% | 10% |
| No inbound mail | 26% | 24% | 17% | 2% |
| Farm profile | 21% | 32% | 26% | 0% |
| Very new | 11% | 0% | 3% | 0% |
| Registry hold | 5% | 3% | 3% | 0% |
| Parked | 2% | 4% | 2% | 3% |
| Alias forwarder | 0% | 0% | 9% | 1% |
| Disposable | 0% | 0% | 0% | 0% |

Three results carry most of the design decisions:

- **The farm-profile conjunction still never fires on a legitimate domain**, at 21% of abuse and 32% of
  the disposable rows against 0% across 212 legitimate ones. That is the case for keeping superadditive
  combinations: each part is innocent alone, so no individual signal could have carried this without also
  hitting legitimate domains. It is also the result that grew most convincing with the collection, since
  it now has twenty times as many abuse domains and the same zero.
- **Free unlimited-alias routing is the sharpest single fingerprint**, flagging 44% of abuse, 64% of the
  disposable rows and 66% of the privacy population against 10% of legitimate domains. It is also the
  clearest illustration of why the privacy group is not graded: the signal is doing exactly what it should
  on both, and only the consumer's policy decides whether that matters. That 10% is the cost side of the
  same trade, and it is where most of the remaining false positives come from.
- **The `disposable` flag effectively never fires.** The temp-mail MX fingerprint matched four families
  across the whole holdout and not one of the 123 rows labelled `DISPOSABLE`, which is a genuine recall
  gap rather than a sampling artefact now that the group is collected in full. It is left alone rather
  than fitted to the holdout, which would be deriving a fingerprint table from the benchmark and would
  invalidate every figure it then produced. This is the gap `1.4.0` addressed from the other direction,
  by adding a third-party verdict as a second route to the same flag. The row above measures only the
  fingerprint: the reputation source is excluded from collection, so nothing here reflects what the
  widened flag does in production. See *One signal is unmeasurable by construction* below.

One row is a description rather than an accusation. **No inbound mail scores nothing in either
direction**, so its 26%-against-2% split moves no domain's number. It reads like a risk signal and is
not one: an account farmer has to receive the verification message, so the domains it selects are
overwhelmingly *dead* rather than dangerous. It is reported because a consumer may want to know, and it is
the reason `mail.mx_present` was removed from the scorer rather than kept as a small positive. See
`docs/SCORING.md`.

## What the signals are worth

Each signal is scored by ablation: rebuild the model without it and measure what changes. Two metrics,
because the two disagree often enough that reporting one would be a choice disguised as a measurement.
ΔAUC is the change in ranking quality, with a 95% interval from 400 cluster-bootstrap resamples over
families. Band errors are the change in the counts the service actually ships, as legitimate domains
entering an actionable band and abuse domains entering a legitimate one.

Conditional lift is the third figure, and it is the one that protects a rare signal: among the families a
signal fired on, the abuse share against the cohort base rate, with a Wilson interval. A signal that fires
twelve times cannot show a ΔAUC, but it can still show that everything it fired on was legitimate.

The 30 signals and 7 combinations of `1.3.0` tier as follows. Eight of those signals are observations
from `1.4.0` and a rerun will not list them:

| Tier | Signals | Combinations | Meaning |
| --- | --- | --- | --- |
| Measurably useful | 8 | 2 | ΔAUC interval excludes zero on the useful side |
| Kept, not distinguishable | 9 | 3 | Fires enough to judge, and the intervals do not separate it from noise, but nothing indicates harm |
| Bands disagree | 3 | 0 | Removing it would raise AUC and cost verdicts; the bands decide |
| Unmeasured | 2 | 1 | Below the 10-family rarity gate, so no figure means anything yet |
| Zero by design | 8 | 0 | Reports to the reader and scores nothing |
| `REMOVE` | 0 | 1 | The rule marks it for removal |

### One signal is unmeasurable by construction

`signup.checkmail` reads a metered third-party API: 1,000 lookups a month against a holdout of several
thousand domains. `lib/analyze.ts` therefore skips it whenever a recording or replay context is active,
which means the audit sees it as `KEEP no data, source never answered` and every figure against it reads
zero. That is the honest result arrived at by the existing rarity rule rather than a special case, but it
has three consequences a reader of the tables above should carry:

- **Its weights are the only ones in the model never validated here.** Every other number was placed by
  an ablation or a cross-validated sweep; these were placed by judgement, and `lib/scoring/weights.ts`
  says so at the block.
- **Reported distributions sit one point below what the service emits.** The signal credits `+1` for a
  clean answer, which never fires under replay, so every domain in a calibration run scores a point
  lower than the same domain would in production. It is not corrected for, because a synthetic
  correction would be fabricating a verdict the source never gave.
- **The flag precision table predates the widened `disposable` flag.** From `1.4.0` that flag is raised
  by either the MX fingerprint or the vendor's disposable verdict, and the figures below were measured
  when only the first existed. The recall gap noted there — the fingerprint matching none of the 123
  `DISPOSABLE` rows — is exactly the gap the second route was added to close, so the true rate in
  production is higher than the 0% recorded, by an amount this holdout cannot measure.

Measuring it properly would mean either a paid tier or a partial run over a stratified subsample, which
is worth doing before its weights are trusted for anything beyond visibility.

The "zero by design" tier holds the seven credits `1.3.0` withdrew but kept collecting, alongside
`economics.unpriced_suffix`, which had been its sole occupant and supplied the idiom. `mail.commercial_rua`
left this tier with the fresh collection, which is the point of that tier being a statement about the
model rather than about the data: a signal belongs in it when reporting the fact is free and nothing
weighs it, not when the run failed to observe it.

All eight became observations in `1.4.0`, which is the same statement made structurally: an observation
has no weight to be zero. The tier itself is kept, because it still catches a signal that applies and
never fires — the unverified `mail.commercial_rua` case is exactly that — and distinguishing it from a
source that never answered remains worth doing.

`mail.bimi` and `footprint.business_services` were the two withdrawn credits that did not land there.
Each owned the DNS queries that fed it, and a fact nothing weighs does not justify a round trip on every
analysis, so both were deleted along with their probes. That is the test the tier applies: reporting the
fact has to be free.

One combination tiers as `REMOVE` and no signal does. `combo.parked_with_mx` measures -0.002 ΔAUC on an
interval of -0.004 to -0.000, which just excludes zero, and it costs one band error in each direction. It
was left alone because `1.3.0` already reprices most of the model, and removing a combination inside the
same change would confound the two. It is the first thing to measure next, and it has now tiered `REMOVE`
on two independent collections.

By dimension, ablating the whole group:

| Dimension | ΔAUC | 95% CI | At `1.2.0` |
| --- | --- | --- | --- |
| `age` | +0.061 | +0.050, +0.072 | +0.048 |
| `signup` | +0.013 | +0.005, +0.022 | +0.005 |
| `configuration` | +0.009 | +0.002, +0.015 | +0.011 |
| `economics` | +0.004 | -0.000, +0.008 | +0.003 |
| `mail` | +0.000 | -0.000, +0.001 | +0.006 |
| `name` | +0.000 | -0.000, +0.001 | +0.000 |
| `footprint` | -0.000 | -0.001, +0.001 | +0.000 |
| `site` | -0.003 | -0.008, +0.001 | -0.005 |

Age still carries the model, and by more than before, which is why registration coverage is the most
consequential limitation here. `age` and `signup` both became more valuable: withdrawing the self-asserted
credits did not only subtract, it stopped them crowding out the evidence that survives.

`mail` and `footprint` both sit at nothing, as they had to. `footprint` holds one live signal,
`footprint.dnssec`, whose own ΔAUC is -0.000 on an interval spanning zero; it is kept on the argument in
`docs/SCORING.md` rather than on a measurement, and it is the smallest thing in the model still drawing
points. `mail` has one live credit that twelve domains qualify for, which is not enough to move a
dimension.

`site` still ablates negative and is still kept; see `docs/SCORING.md` for the reasoning and for the two
other findings measured and deliberately not acted on.

## Threshold sweep

Six tunable scalars are swept under 5-fold cross-validation stratified over families, each fold choosing
its value on four fifths of the families and judged on the fifth it never saw. The objective is the one
the service ships: reduce abuse domains sitting in a legitimate band without letting a single further
legitimate domain into an actionable one.

**Nothing was adopted on this collection.** Five of the six knobs are already at the value their own sweep
picks. The sixth, `clamps.configuration.max`, is beaten by 8 in four folds out of five and would recover
2.2 abuse families per fold, but it admits false positives out of fold, so the constraint rules it out.
That is the same knob `1.2.0` adopted 10 for, and the sweep now declining to move it further is the fixed
point that protocol is supposed to reach.

### Why ΔAUC alone was not enough

`1.1.0` tiered signals on ΔAUC and separation, and called 15 of 39 signals dead or noise. Acting on that
list would have deleted several signals this run shows are load-bearing. Three specific failures, each of
which the current harness addresses:

- **A flat signal and an unmeasured one printed identically.** Both showed `+0.000`, whether they had
  fired six thousand times with no separation or four times with perfect precision. The bootstrap interval
  is what separates them, and the rarity gate is what stops a signal being deleted for the crime of being
  rare: `signup.temp_mail` and `mail.spf_permit_all` both sit below it and are both kept.
  `mail.commercial_rua` is the current illustration, at 12 families and +0.000 ΔAUC with a lift interval
  that excludes 1.00 in the useful direction.
- **AUC ranks; the product bands.** Removing `site.parked` improves AUC and costs 16 verdicts on net,
  letting 18 abuse domains into a legitimate band while freeing 2 legitimate ones from an actionable band.
  That is a straightforward argument for keeping it which a ranking metric cannot express. Three signals
  now carry an explicit `bands disagree` tier rather than being silently resolved in favour of whichever
  metric was consulted first.
- **A dominant family could carry a figure by itself.** Weighting by family and resampling families rather
  than domains is what makes an interval mean anything on a dataset where one operator contributes 99
  near-identical names.

The other half of the fix was not statistical. Most of that original list was starved of firings rather
than flat, and collecting the whole abuse group is what turned "we cannot see this signal" into a
measurement either way.

## Known limitations

- **A third of the holdout has no age evidence.** A creation date was established for 68%, and age is the
  strongest dimension in the model by a factor of six. The missingness is not random: it concentrates on
  the suffixes abuse prefers. Every figure here is therefore a lower bound on what the model would do
  against a population whose registries answer. The composition has changed, though: the port-43 collector
  closed most of the no-RDAP slice, so what remains is 23% of domains where an RDAP server exists and
  timed out. That 23% is what the widened port-43 trigger was built for, and it postdates this collection,
  so the figure is the gap as it stood rather than as it stands.
- **The temp-mail fingerprint matched none of the 123 rows labelled `DISPOSABLE`.** With the group
  collected in full this is a recall gap rather than a sampling artefact, and closing it needs a broader
  fingerprint table built from provider documentation. Fitting one to these 123 rows would make this
  document circular.
- **`mail.commercial_rua` is measured on twelve domains.** It is out of the "zero by design" tier and its
  conditional lift is unambiguous, but twelve is twelve. It sits above the rarity gate by two families,
  which is close enough to it that the next collection could put it below.
- **Free mail routing drives nearly all of the false positives.** Six of the eight legitimate domains in a
  risk band are there because `signup.free_routing` fired, usually alongside a parked page or a young
  registration. This is the one weight where the measured cost to legitimate domains is concentrated
  rather than spread, and the cross-validated sweep keeps it where it is, because the domains it recovers
  outnumber the ones it costs and the fold protocol says so out-of-sample. See the rationale on
  `signup.freeRouting` in `lib/scoring/weights.ts`.
- **The remaining false positives are genuinely ambiguous or genuinely odd.** One is inside its first
  term and close to expiry, one is under 30 days old serving a parking page, and one is a legitimate
  domain sitting under an RDAP registry hold, which the model is right to treat as decisive even though
  the label says otherwise.
- **The ablations are measured on the cohort the tuning was cross-validated against.** The folds bound how
  much a swept threshold can memorise, but they do not make this a second dataset. A poor ablation
  establishes that a signal is not earning its place *here*; a second collection, from different sources,
  is what would establish that a removal generalises. Re-collecting the same domains, as this run did,
  does not supply that: it refreshes the observations without changing which domains are being observed.
- **The `1.3.0` removals are not evidenced here at all, and cannot be.** They were made against an
  adversary who adapts, and every domain in this holdout was collected before the model existed. A dataset
  that could measure fake-resistance would have to be built by an attacker optimising against this scorer.
  What this document can say is what the change cost on the unadapted population, which is recorded above
  in full.
