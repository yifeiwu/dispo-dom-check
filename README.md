# Signup risk scorer

Enter a domain or an email address and get an explained assessment of whether the domain looks built to
mint mailboxes or to run a business.

Almost every signal is derived from the domain's own registration record, DNS, mail configuration,
suffix pricing and served content, all of it from sources that are free and need no account. The one
exception is an optional reputation lookup against Check-Mail.org, which takes an API key: with no key
set it reports as unconfigured, contributes nothing, and every other signal scores exactly as it would
have. Note that with a key set, each analysed domain is transmitted to that vendor — see
`docs/SOURCES.md`.

The registration record is read over RDAP wherever a registry answers, and over WHOIS on port 43 wherever
one does not: either the suffix publishes no RDAP service at all, which is the case for 238 of the root
zone's suffixes including `.de`, `.it`, `.se` and `.jp`, or the server exists and stalls rather than
replying. Age is the heaviest-weighted signal in the model, so both cases previously scored without it
entirely.

## What problem this solves

The threat model is **mass account creation, not phishing**. The question is not whether a domain is
malicious but whether it can produce unlimited deliverable addresses cheaply, and whether it was
created to do so. That single decision drives everything else:

- Disposable and forwarder mail detection is the primary dimension, since one domain yielding unlimited
  addresses is the core capability an account farmer needs.
- Registration economics and age come next. Price, age and mail-provider class capture most of the
  available value.
- Phishing-oriented signals are excluded rather than merely down-weighted. Lookalike names, hosting
  reputation and blocklist membership do not describe this abuse.

Every credit keys on evidence **somebody other than the domain had to supply**, which is the thing an
account farmer cannot mint at scale. A record a domain publishes about itself is still collected and
still reported, because it is a fact a reader wants next to a verdict, but it earns nothing: an SPF
include, a DMARC policy or a vendor verification token costs a few minutes in a DNS console, so paying
for any of them prices what an operator was willing to type. See `docs/SCORING.md`.

## Two numbers, never one

| Output | Meaning |
| --- | --- |
| `legitimacy` 0-100 | Additive evidence from a neutral 50. `risk` is its complement. |
| `confidence` 0-100 | Weighted coverage of the sources that actually answered. |

Confidence is reported with equal prominence because absence of evidence is not evidence of abuse. A
legitimate new small business and a fresh farm domain look alike, so below a confidence of 40 the
verdict is withheld as `insufficient_evidence` rather than guessed.

The rule the whole model rests on: **penalise only on positive evidence of a problem.** A missing DMARC
record, absent DNSSEC or an unreachable source contributes nothing in either direction and only lowers
confidence. This is enforced by tests, because it is the rule a well-meaning weight change is most
likely to break.

## Getting started

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

```bash
npm test                       # scoring fixtures, input normalisation, price snapshot
npm run lint                   # eslint
npm run build                  # production build
npm run probe -- <domain>...   # readout for one or more domains against a running server
npm run refresh:pricing        # update the committed suffix price snapshot
```

Two further scripts measure the model against a labelled holdout, read from `benchmark/` as three
grouped files — `abuse.csv`, `legitimate.csv` and `privacy.csv` — which are held locally and
deliberately not committed, so the scripts only run with a copy of that dataset present.
`npm run calibrate` reports whether the weights separate the groups and where the bands should sit;
`npm run audit` asks the narrower question of whether each individual signal earns its place. Both only
report, and neither writes back into `lib/`.

The privacy group is reported but never graded. A forwarding service is a legitimate product that is
also ideal for minting accounts, so counting those domains as either class would score the model against
a policy decision it deliberately leaves to the consumer.

Only the audit probes anything, under `npm run audit -- --collect`, and it keeps every response it gets.
Both scripts then read that one store, so re-measuring costs nothing and neither can disagree with the
other about what was observed: a weight change is re-scored from cached facts, and a collector change is
answered by `npm run audit -- --reparse`, which rebuilds those facts from the stored responses with no
network at all. See `docs/CALIBRATION.md`.

## How it is put together

```
lib/domain.ts        input normalisation, the out-of-scope gate, discards any local part
lib/collect/*.ts     one file per source, each returning normalised facts
lib/facts.ts         DomainFacts: the single normalised collector output
lib/analyze.ts       orchestration, and where the never-block contract is enforced
lib/scoring/*.ts     pure scoring over facts plus config
app/api/analyze      the endpoint, always 200 with whatever was collected
app/api/model        the live config and every rationale, as data
app/how-it-works     the explanation page, rendered from /api/model
components/*.tsx     the result views: gauge, dimensions, signals, sources
```

Two boundaries carry the design.

**Collection is separated from scoring.** Scoring is a pure function of `DomainFacts` and a
`ScoringConfig`, with no I/O at all. A fixture is therefore just a facts snapshot, so a weight change
can be re-tested offline with no network and no risk of a source having changed underneath the test.

**Every weight lives in one file.** `lib/scoring/weights.ts` is the only place a weight, threshold,
clamp, band boundary or override value is allowed to exist. Signals read their numbers from the config
they are passed, never from inline literals, which is what makes the scheme genuinely tunable rather
than nominally so.

## No source can block a request

Collectors run concurrently under per-source and global deadlines. Whatever finished is scored;
whatever did not is reported with a status and a human-readable reason and contributes no points. The
endpoint returns `200` with partial results, and the UI shows exactly which sources answered.

That contract is also reported while it is happening rather than only afterwards. Asking `/api/analyze`
for `application/x-ndjson` returns the same analysis as a stream: one line per source as it settles,
then the identical payload as a terminal `result` line. The statuses are the ones the finished result
carries, so a progress view and the `Sources` panel cannot describe the same source differently. Plain
JSON stays the default, because a caller that asked for one object should not have to learn a framing
to keep working. A rejected input is still a `400` with a plain body, since it is knowable before any
work starts and there is nothing to stream.

This is not defensive decoration. During development the suffix price feed was measured at 12 to 14
seconds, which is longer than the whole analysis budget, and the web archive index timed out entirely.
The two were resolved differently, according to how fast the underlying data actually changes and how
much the source was worth:

- **Suffix prices** are a committed snapshot refreshed by `npm run refresh:pricing`, not a request-time
  fetch. Prices move on the order of months, so snapshot staleness costs far less than a dimension that
  timed out on every request.
- **The registry bootstrap** is fetched live but cached for the process and refreshed in the background,
  since it changes daily.
- **The port-43 server map** is a committed snapshot of IANA's root database, refreshed by
  `npm run refresh:whois`. Which server answers for a suffix changes on the order of years, and looking it
  up live would cost a second round trip on the slowest transport in the system before the real query.
- **The archive index was dropped**, along with certificate transparency. Both could only ever raise a
  lower bound on age rather than establish it, which did not justify their cost. See `docs/SOURCES.md`.

No domain-specific result is cached. Every domain is analysed from scratch on every request. The
calibration scripts do keep the responses they probe, but that store is theirs alone and no request path
ever reads it.

## Explaining the score

Signals are declared as data, each carrying its own `rationale`, and results separate two things that
are easy to conflate:

- **Rationale** — why the heuristic exists at all. Fixed text.
- **Evidence** — what was actually observed for this domain.

A reader who disagrees with a verdict needs both to tell a wrong observation from a weight they would
have set differently. Three outcomes are rendered as three groups rather than one list: the heuristics
that moved the score, sorted under their dimension; the ones that measured something and came out at
zero, collapsed; and the ones that did not apply, collapsed, because there was nothing to measure
rather than nothing to report.

`GET /api/model` returns the active config plus every signal and combination definition with its
rationale, and the how-it-works page renders from those same objects, so user-facing documentation
cannot drift from what the scorer does.

## Combinations

A purely additive model errs in both directions, so the model adjusts in both:

- **Superadditive**, where each part has an innocent explanation that only the conjunction eliminates. A
  new cheap domain may be a startup and a mail-only domain is a legitimate setup, but together with no
  website they describe a domain whose sole function is receiving mail at throwaway cost. In
  verification this conjunction never fired on a legitimate domain.
- **Sign-flipping**, where a conjunction bounds the result rather than nudging it. An accredited suffix,
  several years of history and a paid per-seat mail tenancy together floor the score outright, because no
  plausible farm domain holds all three. Positive overrides are what keep false-positive pressure off
  established organisations, which is the failure mode that costs a consumer real users. There is
  deliberately no drop-catch override in the other direction: establishing that a domain lapsed and was
  recaught needs an independent history to date the gap against, and no remaining source provides one, so
  age credit is inherited by a new owner. That is a known gap rather than an oversight.
- **Subadditive**, which is the half that protects ordinary domains. Absent DMARC, absent DNSSEC and no
  vendor verification records are three measurements of one underlying fact — an operator who never got
  round to any of it — and that describes most legitimate small businesses. Rather than discount the
  group, the model charges nothing for any of those absences in the first place, and reports the
  conjunction so that a reader can see it was noticed and deliberately not held against the domain.

Interaction terms are where overfitting enters, so the set is small, each carries a written rationale,
each is pinned by a fixture, and the total is capped.

## Privacy

A full email address is accepted because that is the form a consumer usually holds, but **the local part
is discarded at the boundary** and is never stored, logged or returned. Local-part heuristics were
considered and removed outright: a teacher registering a class, a family, or a team creating sequential
accounts all produce exactly the patterns those heuristics key on, so the false-positive cost lands on
ordinary people rather than on abusers.

**The reputation lookup sends the domain to a third party.** Nothing else here does: every other source
is either a committed table or a question put to infrastructure that already knows the domain exists.
The vendor retains what it is sent and publishes a "recently checked domains" list whose relationship to
API traffic it does not document, so with a key configured, treat an analysed domain as potentially
public knowledge. Leaving `CHECKMAIL_API_KEY` unset removes this entirely.

## Deploying

Deploys to Vercel with no configuration. One optional environment variable, `CHECKMAIL_API_KEY`, enables
the reputation lookup; see `.env.example`. The analysis route runs on the Node runtime with a
`maxDuration` of 60 seconds against a 15-second internal budget, so the platform never cuts a response
that the orchestrator would have degraded gracefully. The route also carries a small in-memory rate
limit, which is a courtesy brake on the free upstream APIs rather than a security control, since
serverless instances do not share it.

Bear in mind that the reputation tier is 1,000 lookups a month and `npm run dev` spends from the same
allowance as production. Calibration and audit runs never touch it, by construction rather than by
convention.

## Stated limitation

This tool reports that a domain is *structurally* risky far better than it reports that a domain is
*known* bad. Every signal but one derives from what the domain itself publishes, so a name that is
perfectly configured and already burned in someone's threat feed will still score well. The optional
reputation lookup narrows that gap and does not close it: it is a single signal, it holds no weight in
confidence, and it is absent entirely without a key. Treat the score as an independent signal to combine
with your own blocklist, not as a replacement for one.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/SCORING.md` | Why each dimension, combination and band exists, and what was measured and dropped |
| `docs/SOURCES.md` | Every source, what it returns, and every source rejected with the observed reason |
| `docs/CALIBRATION.md` | Measured separation against a labelled holdout, dated to the model it was run against |
| `GET /api/model` | The live numbers: every weight, tier, clamp and band, with each rationale |

The split is deliberate. Prose describing weights drifts from the weights, so the numbers are served
from the registries the scorer evaluates and the documents carry the reasoning instead.
