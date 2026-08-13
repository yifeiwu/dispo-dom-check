# Calibration

The headline figures below — measured separation, the signal tiers, the threshold sweep and the flag
rates — come from a collection of the whole holdout taken on 13 August 2026 and scored at model `1.6.0`,
reproducible offline from the stored responses as described under "Reproducing". The `1.6.0` signals were
measured against that same collection: `site.hosted_platform` by re-deriving facts from the stored
responses, and `mail.bimi` by a separate one-query census, for the reasons under "Pricing the 1.6.0
signals" below.

**Not every section is from that collection**, and each one that is not says so at its heading. This
document is a dated report rather than a description of what ships, and older sections are left standing
rather than rewritten, because a measurement is only meaningful alongside the version and the collection
it was taken against. Regenerate the current figures with `npm run audit` and `npm run calibrate`.

Two things remain unmeasured here, both by construction rather than by omission:

- **`signup.checkmail`** reads a metered source that `lib/analyze.ts` excludes from every recorded and
  replayed run, so every figure against it reads zero. The section "One signal is unmeasurable by
  construction" below sets out what that costs.
- **`signup.temp_mail_endpoint` and `signup.disposable_token`**, added in `1.5.0`, fired on no holdout
  domain at all. They are unfalsified rather than validated, and "The recall gap after `1.5.0`" below is
  the fullest statement of what this benchmark can and cannot say about them.

A third belongs beside them from `1.6.0`: **`mail.bimi` and `site.hosted_platform` are both too rare here
to price**, at 1 and 6 qualifying domains respectively. Unlike the two above they did fire, so what is
missing is quantity rather than any evidence at all. Both ship at zero.

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

The figures in this subsection are from the `1.3.0`-era collection, which is where the port-43 collector
was first measured at all. The current collection is described in the subsection after it, and the two are
compared there directly.

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

### What the widened port-43 trigger was worth, measured

The re-collection for `1.5.0` is the first run in which WHOIS was attempted wherever RDAP produced no
answer, rather than only where a suffix publishes no RDAP service. Both collections are of the same 4,699
domains, taken fourteen hours apart, and the second took 21 minutes at a concurrency of 8 with WHOIS
reporting rate limiting on 1% of domains and RDAP on none — so the tighter port-43 limits, which were the
reason for caution, did not bind at this size.

| Source of the creation date | Before the widening | After |
| --- | --- | --- |
| RDAP | 3,478 (74%) | 3,153 (67%) |
| WHOIS | 377 (8%) | 696 (15%) |
| **Any source** | **3,820 (81%)** | **3,802 (81%)** |

Read the middle column first, because the flat total conceals the result rather than being it. RDAP
answered **325 fewer** domains on the second run — ordinary variance in how quickly registries reply, of
the same kind the previous collection saw in the other direction — and port 43 recovered **319 of them**.
Under the narrow trigger those 325 domains would simply have had no age at all, and age is the heaviest
dimension in the model by a factor of six.

So the widening is insurance rather than coverage, and it paid out on the first run it was exposed to. It
adds nothing when RDAP is healthy and holds the line when RDAP is not, which is exactly the shape claimed
for it when it shipped unmeasured in `1.4.0`. The two protocols fail independently; the flat total is the
evidence that they do.

## Measured separation

Scoring `legitimacy`, where higher is more legitimate:

| Label | Group | n | median | mean | p10 | p90 |
| --- | --- | --- | --- | --- | --- | --- |
| `ABUSE` | Abuse | 4,292 | 19 | 23.3 | 0 | 53 |
| `DISPOSABLE` | Abuse | 123 | 13 | 18.7 | 0 | 45 |
| `LEGITIMATE` | Legitimate | 212 | 70 | 66.7 | 46 | 89 |
| `PRIVACY` | Not graded | 58 | 13 | 22.8 | 0 | 59 |

Separation between the abuse and legitimate medians is **51 points**. Ranked by risk,
abuse-versus-legitimate AUC is **0.943**, family-weighted, over 4,415 abuse against 212 legitimate
domains. Band errors are 7 legitimate domains in an actionable band (3%) and 207 abuse domains in a
legitimate band (5%).

Thirteen domains are absent from the table because they were never scored: two abuse rows rejected as
malformed input, and eleven legitimate rows ruled `out_of_scope` as shared free provider vanity domains,
which is the gate working rather than a failure to score them.

### What the `1.5.0` collection was worth, separated from the model change

The same discipline as the section below it, applied to the same question one release later: the identical
`1.5.0` model was scored against both the pre-widening collection and the fresh one, so that new evidence
and new weights can be told apart. The third column then ablates the one weight `1.5.0` placed, which
separates the two halves of the change completely.

| | `1.4.0` evidence | `1.5.0` evidence, `wildcardMx` at 0 | `1.5.0` evidence and weight |
| --- | --- | --- | --- |
| Legitimate domains in an actionable band | 8 (3.8%) | 7 (3.3%) | 7 (3.3%) |
| Abuse domains in a legitimate band | 219 (5.0%) | 216 (4.9%) | 209 (4.7%) |
| Best separating threshold, Youden J | 0.691 | — | 0.679 |
| AUC | — | 0.944 | 0.943 |

Read across: re-collecting recovered one legitimate domain and three abuse ones, which is the port-43
widening and ordinary run-to-run movement together and is not large. The `wildcardMx` weight then
recovered seven more abuse domains at no cost in the other direction — the whole of its contribution, and
the reason it ships despite ranking slightly worse with it than without.

The two ranking figures moving the wrong way while the band figures move the right way is the honest
statement of what this weight is. It is not an argument the weight is free; it is the argument that the
service ships bands and the bands improved. A reader who prefers ranking has the number to act on.

The baseline collection those first-column figures came from has since been deleted. It was 50 MB of
transcripts whose only remaining purpose was this table, and a stale collection cannot answer a question
about the current collectors — which is the reason it was re-taken.

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
| 40 | 70.0% | 96.7% | 0.667 |
| 44 | 73.6% | 94.3% | 0.679 |
| 48 | 75.9% | 85.4% | 0.613 |
| 50 | 79.4% | 84.4% | 0.639 |
| **51** | **93.3%** | **75.0%** | **0.683** |
| 52 | 93.5% | 74.1% | 0.675 |
| 55 | 95.3% | 71.2% | 0.665 |
| 56 | 95.7% | 70.8% | 0.665 |
| 60 | 96.8% | 64.2% | 0.609 |
| 64 | 97.5% | 61.8% | 0.593 |

The cliff that placed this edge is still the dominant feature of the sweep, and under `1.5.0` it has
sharpened rather than moved: recall jumps 14 points between a floor of 50 and one of 51, in a single
point. What changed is which side of the cliff the best Youden J now sits on. It is 51, at 0.683 against
0.665 for the configured 55, where the two were within 0.001 of each other before.

The floor stays at 55, because Youden J is not the objective this model ships. It weights the two error
rates equally, and the classes here are not equal sizes: dropping the floor to 51 would move 8 legitimate
domains into a legitimate band and 88 abuse domains along with them, taking abuse in a legitimate band
from 4.7% to roughly 6.7% and out of the budget every version of this model has been tuned inside. The
gain is 3.8 points of a rate on 212 domains; the cost is 2.0 points of a rate on 4,415. A floor placed on
the ranking metric would take that trade and the shipped bands should not.

Nothing else recommends 51 either. It is one point past a cliff, which is the least stable place on a
sweep to stand — 50 scores 0.639 and 52 scores 0.675 — and band edges are not carried through the
cross-validated procedure the weight knobs are, so there is no out-of-fold evidence that this peak
survives a different split.

That this edge has not moved is still the most informative single fact in this document. It was 58 under
`1.0.0`, followed the distribution to 55 in `1.1.0`, and has now held through a twentyfold increase in the
abuse sample, every removal in `1.2.0`, a change in `1.3.0` that took the top off the legitimate
distribution, a complete re-collection of the holdout, and the weights `1.5.0` added. A boundary that
survives that is positioned on something real, and the first sweep to prefer a different number prefers
it by 0.018 of a metric this service does not ship.

The other three edges all moved in `1.3.0`, because the legitimate distribution lost its top: its ninetieth
percentile fell from 100 to 88 and its median from 80 to 70. Bands drawn for a scale an ordinary business
could top out on do not fit that, and holding them would have doubled the false-positive rate while
leaving the old `established` floor of 80 reachable by 29% of legitimate domains rather than half of them.

| Band | Range | Of abuse | Of legitimate |
| --- | --- | --- | --- |
| `high_risk` | 0–18 | 49.9% | 1.9% |
| `suspicious` | 19–39 | 20.0% | 1.4% |
| `unclear` | 40–54 | 25.3% | 25.5% |
| `probably_legitimate` | 55–69 | 3.2% | 21.7% |
| `established` | 70–100 | 1.4% | 49.5% |

The abuse half moved down *within* the actionable range under `1.5.0` rather than further into it.
`high_risk` took 39.3% of abuse domains at `1.4.0` and now takes 49.9%, while `suspicious` fell from
28.0% to 20.0%; the two together moved by under three points. Which weight did that is not isolated here,
and the ablations below report each one's effect on ranking rather than on band membership.

`high_risk` is configured at exactly 18, which the run confirms is precisely where it stops taking more
than 2% of legitimate domains: the sweep reports 18 as the highest ceiling available and 18 is what is
configured. It takes the measured limit rather than a margin past it because it is the one boundary where
being wrong means blocking somebody real. `established` would need a floor of 67 to hold abuse below 2% of
its own class and is configured at 70, keeping three points of conservatism.

The ceiling on the actionable bands, at 39, is the one edge positioned by the false-positive budget rather
than by separation. 3.3% of legitimate domains fall below 40, which is inside the 5% this model has always
been tuned to, and holding the old ceiling of 49 would have taken far more.

The lower edge of `unclear` is therefore no longer pinned to the neutral base of 50. What the pin
protected still holds — a domain with no evidence either way scores 50 and lands in `unclear` by
construction — but the edge is now fitted, because a scale with less positive evidence available puts
ordinary domains below the base without that being evidence against them.

What the bands produce:

| Outcome | Abuse (n=4,415) | Legitimate (n=212) |
| --- | --- | --- |
| Actionable band (`high_risk` or `suspicious`) | 70.0% | 3.3% |
| `unclear` | 25.3% | 25.5% |
| Legitimate band | 4.7% | 71.2% |

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

### The recall gap after `1.5.0`, which attacked it directly and did not close it

`1.5.0` added three signals aimed squarely at the row above, on the reasoning that the gap is structural:
the throwaway-inbox services that sell custom domains instruct the customer to publish a mail exchanger
*inside their own zone*, so the hostname names the customer and a table of provider hostnames cannot see
them however long it grows. The holdout was then re-collected in full so all three could be measured.

**The flag still reaches none of the 123.** The result, family-weighted:

| Signal | Families | Abuse | Legitimate | Lift | ΔAUC | Band delta |
| --- | --- | --- | --- | --- | --- | --- |
| `signup.temp_mail` | 4 | 0% | 0% | 0.54–1.06 | +0.000 | +0/+1 |
| `signup.temp_mail_endpoint` | 0 | 0% | 0% | — | +0.000 | +0/+0 |
| `signup.disposable_token` | 0 | 0% | 0% | — | +0.000 | +0/+0 |
| `signup.wildcard_mx` | 124 | 3% | 5% | 0.91–1.01 | -0.001 | +0/+7 |

The two signals built to reach the disposable population fired on **no holdout domain at all**, so they
are unfalsified rather than validated, and nothing here says whether they work. Both are kept. The cost of
each is bounded — one conditional address lookup for the first, a read of an already-fetched record for
the second — and a fingerprint that has not yet met its population is a different state from one measured
and found flat. What must not happen is the obvious repair: fitting the endpoint or token tables to these
123 rows would derive them from the benchmark and make every subsequent figure circular, which is the same
rule that keeps the MX table built from provider documentation alone.

The wildcard probe did reach the population, and it says something the design did not expect. A wildcard
MX is **more common among the legitimate half of this holdout than the abuse half** — 5% of legitimate
families against 3% of abuse — and on the `DISPOSABLE` group specifically it added nothing at all:
`catch_all_capable` covered 64% of those rows before the probe existed and 64% after. Mail-server
operators publish wildcards so that departmental names keep working, and that turns out to be at least as
common as an operator publishing one to farm addresses. The signal ships at -12 regardless, on band
errors rather than on ranking; the entry in `docs/SCORING.md` sets out that argument and this table is the
evidence against it.

What the whole exercise establishes is narrower than what it set out to do, and worth stating plainly: the
custom-domain disposable population is reachable in principle by address and by token, and this holdout
cannot tell whether either mechanism works, because the 123 rows in it do not use the one provider whose
endpoint and token are published. Closing that would need a labelled set drawn from the services
themselves rather than more signals.

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

The 25 signals and 7 combinations of `1.5.0` tier as follows, after the two removals described below:

| Tier | Signals | Combinations | Meaning |
| --- | --- | --- | --- |
| Measurably useful | 8 | 2 | ΔAUC interval excludes zero on the useful side |
| Kept, not distinguishable | 8 | 3 | Fires enough to judge, and the intervals do not separate it from noise, but nothing indicates harm |
| Bands disagree | 4 | 1 | Removing it would raise AUC and cost verdicts; the bands decide |
| Unmeasured | 4 | 1 | Below the 10-family rarity gate, so no figure means anything yet |
| No data | 1 | 0 | The source is excluded from collection by construction |
| `REMOVE` | 0 | 0 | The rule marks it for removal |

Two movements since `1.3.0` are worth naming. The "zero by design" tier is gone, because the eight
entries that filled it became observations in `1.4.0` and the audit no longer lists them. And the
`REMOVE` row is empty because the two entries that filled it have been removed rather than argued with,
which is the first time that has been the reason.

Three of the four unmeasured signals are the disposable family, two of which fired on nothing at all.
That tier is doing exactly the job it was built for — recording that a signal has no evidence either way,
rather than letting a zero read as a verdict. **Nothing in that tier was removed, and the distinction is
the whole reason the tier exists**: a signal that has not met its population is not the same as one
measured and found flat, and deleting on the first would be fitting the holdout. `signup.disposable_token`
costs no query at all, and `signup.temp_mail_endpoint` costs one conditional lookup on the 362 of 4,699
domains whose mail exchanger names its own zone — 7.7% of the population, or 0.08 queries per analysis
against a fan-out of about 15.

### Two removals, and the guard clause that was hiding one

`footprint.dnssec` was removed, and the organisational-footprint dimension went with it as its last
member. It fired on 185 families, 5% of abuse against 6% of legitimate, with a conditional lift interval
of 0.94–1.02 spanning 1.00 and a ΔAUC interval spanning zero. Removing it left AUC unchanged at 0.943 and
moved band errors from 7/209 to 7/207 — two abuse domains out of a legitimate band, no legitimate domain
into an actionable one.

It is worth being precise about why this one is different from the nine removed in `1.3.0`. Those failed
the verification rule and were removed *despite* measuring useful, because a string a domain publishes
about itself is free to mint whatever this holdout says. `footprint.dnssec` passes that rule outright: the
resolver validated the chain to the root. It was removed on the ordinary evidence.

**Unweighted, it does not merely fail to separate the classes — it reverses.** 16% of abuse domains are
signed against 6% of legitimate ones. The suffix breakdown shows what the credit was actually reading:

| Suffix | Domains | Signed | Legitimate rows |
| --- | --- | --- | --- |
| `.cfd` | 49 | 47% | 0 |
| `.id` | 1,548 | 39% | 5 |
| `.org` | 87 | 8% | 18 |
| `.net` | 71 | 6% | 7 |
| `.com` | 751 | 4% | 76 |

Signing is concentrated in the cheap bulk namespaces whose registrars enable DNSSEC by default, and those
are exactly where the generated abuse families live. Family weighting collapses each of those families to
one count, which is why the audit reports a level 5%/6% rather than a reversed 16%/6% — the weighting is
working as designed, and the unweighted figure is the one that explains the finding rather than the one
that should price it. On `.com` and `.org`, where enabling DNSSEC is still a decision somebody makes, the
rates match ordinary gTLD adoption and almost nobody makes it.

The credit was therefore reading the registrar's default rather than the registrant's effort. The fact is
still collected and reported as an observation, since the `AD` flag arrives on a query made anyway. It is
the only observation there for being measured flat rather than for being self-asserted, and a
better-balanced collection could reverse it — though the mechanism found here is not the sort a different
sample fixes, since one-click enablement is a property of the registrar market rather than of this
holdout.

`combo.wildcard_mx_young_no_site` was removed as well. It shipped at zero points in this same version and
stayed at zero across all five folds in two separate sweeps. Firing on 1% of abuse domains and 0% of
legitimate ones while contributing nothing, it did not earn a registry entry, a config key and a sweep
knob.

**The audit did not propose the first removal until its own rule was corrected**, and the fault is worth
recording because it was silent and directional. The `REMOVE flat` branch skipped any signal whose removal
changed band counts *in either direction*. That guard implements the policy stated below — where ranking
and bands disagree, the bands win — but that policy is about removals which *cost* verdicts. Applied
symmetrically it also spared signals whose removal *gained* them, which is the opposite of the policy, and
it had been quietly protecting the one class of signal there is least reason to keep: measured,
indistinguishable from random, and mildly harmful at the boundary. The branch now reads the signed band
cost. With the fix in place the rule marked `footprint.dnssec` and nothing else; after both removals it
marks nothing at all, and every threshold knob still wins its own sweep.

### Pricing the `1.6.0` signals, and why both ship at zero

Two signals removed in earlier releases for being unverifiable came back with the verification actually
performed. Both were priced before any weight was placed, by the cheapest method that could answer, and
both came out at zero. Neither result is about the signals being wrong.

**`site.hosted_platform` cost nothing to measure.** The stored responses already contain what it reads:
2,873 site probes, 1,460 of them carrying response headers. Re-deriving facts with `--reparse` and
re-running the audit priced it without a single new request.

| Tier | Domains | Abuse | Legitimate |
| --- | --- | --- | --- |
| Served and addressed, paid platform — **the scored tier** | 6 | 0 | 6 |
| Served only — reported as an observation | 3 | 1 | 2 |

Six domains, no abuse among them, and a sweep entered at zero that chose zero in all five folds. Six
families is below the ten-family rarity gate, and a weight fitted to six domains is fitted to those six
domains. A second bound would have made it moot anyway: all six serve real websites — necessarily, since
a platform is serving them — so `site.substantiveContent` at +6 has already reached the +6
`clamps.site.max` before this is added, and every point of a credit would be clamped away. Raising the
clamp was rejected, because the two credits are one fact seen twice.

The useful output was a defect rather than a weight. **Squarespace is a registrar as well as a site
builder**, and a domain registered through it with no site attached is served a Squarespace parking page,
from Squarespace's own addresses, carrying `x-contextid` and `server: Squarespace`. That satisfies every
test the scored tier applies while being the exact opposite of what the tier is meant to establish, and
one abuse domain reached the tier that way. A parked page is now never read as a platform serving a
domain: where a platform is also the registrar, serving proves nothing about a purchase.

Finding that exposed a second, older gap. Of the four Squarespace parking pages in the holdout, three
were caught by the `coming soon` body fingerprint and the fourth was not — it was titled 近日中に公開, the
same page in Japanese. Every fingerprint in that list is an English phrase, so the list systematically
misses localised parking pages. The parking bundle's asset path is now matched instead, which is
language-independent, and the previously missed domain scores the parking penalty.

**`mail.bimi` could not be measured from stored data at all**, since no `_bimi` lookup exists in any
transcript — the query was removed in `1.3.0` along with the credit. Rather than re-collect the holdout,
`scripts/bimi-census.mts` ran one TXT query per domain: 4,698 queries in about thirty seconds.

| Group | Domains | BIMI record | With a certificate |
| --- | --- | --- | --- |
| Abuse | 4,417 | 1 | 0 |
| Legitimate | 223 | 4 | 1 |
| Privacy | 58 | 0 | 0 |

Five records, one certificate. Three of the four legitimate records are Proton domains and so are one
family, leaving three families in total. The single abuse record is `astermail.org`, publishing a BIMI
record with no certificate behind it — which is exactly the shape the removed signal used to pay `+8`
for, and a fair illustration of why it was removed. One qualifying domain cannot support a weight, so the
census ended the question for the cost of thirty seconds rather than a full re-collection.

That leaves the verifier unproven in the accepting direction, which the fixtures cannot fix: they are
generated locally, and a verifier that rejected everything would pass all of them. `benchmark-bimi/`
holds 42 large brands, kept out of `benchmark/` so that forty of the internet's biggest companies do not
join a 212-family population of small businesses and flatter every figure in this document. Of those, 20
served a chain and **16 verified** — across all three authorities, including a `GlobalSign Verified Mark
Root R42` that the authority table had omitted until the set found it.

The four rejections are worth reporting because none is a defect:

| Domain | Certificate expired |
| --- | --- |
| `sendgrid.com` | 31 December 2025 |
| `entrust.com` | 1 February 2026 |
| `wellsfargo.com` | 26 July 2026 |
| `zoom.us` | 11 August 2026 |

Two of the four lapsed within three weeks of the run, and one of them belongs to a Mark Verifying
Authority. VMCs are annual and evidently lapse often even at companies with the budget and the reason to
renew them.

That is why the query is kept despite the zero weight, and why the failure is reported as a sentence
rather than a status. Every rejection here was correct, and a reader shown only that verification failed
would reasonably have suspected the verifier in all four cases; shown "the certificate has expired — it
expired on 11 August 2026", there is nothing left to wonder about. The same run also found
`salesforce.com`, `tripadvisor.com` and three Proton domains publishing a BIMI record with no certificate
at all — the shape the removed signal paid `+8` for, now reported as what it is.

The trust anchors in `lib/data/bimi-authorities.ts` come from this set rather than from documentation.
Eighteen unrelated brands chaining to one DigiCert key is an observation that it is a Mark Verifying
Authority key; a fingerprint transcribed from a vendor page would be an act of faith in the page.

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

`combo.parked_with_mx` is the entry that carried the `REMOVE` tier for two collections and no longer does.
It measures -0.001 ΔAUC on an interval of -0.003 to -0.000, which still just excludes zero, so the ranking
would drop it. The bands do not: removing it costs one verdict and gains none, so it now tiers as a
bands-disagreement alongside three signals with the same shape. It is a genuine disagreement rather than a
deferral, which is what it was when `1.3.0` left it alone to avoid confounding a removal with a repricing.

By dimension, ablating the whole group:

| Dimension | ΔAUC | 95% CI | At `1.2.0` |
| --- | --- | --- | --- |
| `age` | +0.068 | +0.058, +0.081 | +0.048 |
| `signup` | +0.010 | +0.002, +0.018 | +0.005 |
| `configuration` | +0.008 | +0.002, +0.013 | +0.011 |
| `economics` | +0.005 | +0.001, +0.009 | +0.003 |
| `mail` | +0.001 | +0.000, +0.001 | +0.006 |
| `name` | +0.000 | -0.000, +0.001 | +0.000 |
| `site` | -0.003 | -0.006, +0.001 | -0.005 |

There are seven rows where there were eight. `footprint` is absent because it no longer exists: it
measured -0.000 on an interval spanning zero across two collections while holding a single live signal,
and both went in `1.5.0`. It had been kept on the argument in `docs/SCORING.md` rather than on a
measurement, which is a defensible thing to do once and not twice.

Age still carries the model, and by more than before, which is why registration coverage is the most
consequential limitation here. `age` and `signup` both became more valuable: withdrawing the self-asserted
credits did not only subtract, it stopped them crowding out the evidence that survives.

`mail` sits at almost nothing, as it had to: it has one live credit that twelve domains qualify for, which
is not enough to move a dimension.

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

- **A fifth of the holdout has no age evidence.** A creation date was established for 81% on the `1.5.0`
  collection, and age is the strongest dimension in the model by a factor of six. The missingness is not
  random: it concentrates on the suffixes abuse prefers. Every figure here is therefore a lower bound on
  what the model would do against a population whose registries answer. The widened port-43 trigger has
  now been measured and it does not shrink this gap so much as stop it growing — it converts RDAP
  failures into WHOIS answers rather than reaching domains neither protocol can.
- **The `disposable` flag still reaches none of the 123 rows labelled `DISPOSABLE`, after a release spent
  attacking it.** `1.5.0` added an address fingerprint and an ownership-token match aimed precisely at the
  custom-domain shape that defeats hostname matching, re-collected the holdout, and both fired on zero
  domains. The tables hold what the providers publish, and the 123 rows do not use those providers. This
  is now the clearest limitation in the document: it is not a signal that was tried and failed, it is a
  population this benchmark cannot speak to, and closing it needs a labelled set drawn from the services
  themselves rather than more signals. Fitting either table to these 123 rows would make this document
  circular, which is why it has not been done.
- **`signup.wildcard_mx` fires more often on legitimate domains than on abuse ones.** It ships at -12 on
  band errors, against a lift interval spanning 1.00 and a ΔAUC of -0.001. The bands are what the service
  emits and they improve by seven domains at no cost in the other direction, but a reader who weights
  ranking would reasonably reach the opposite decision, and the number to do so with is above.
- **`mail.commercial_rua` is measured on twelve domains.** It is out of the "zero by design" tier and its
  conditional lift is unambiguous, but twelve is twelve. It sits above the rarity gate by two families,
  which is close enough to it that the next collection could put it below.
- **Free mail routing drives nearly all of the false positives.** Five of the seven legitimate domains in a
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
