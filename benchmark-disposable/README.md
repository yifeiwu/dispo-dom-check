# Disposable custom-domain mechanism set

Kept deliberately apart from `benchmark/`. Nothing here is scored, nothing here enters a calibration
figure, and it exists to answer one question the holdout cannot: **do the custom-domain disposable
routes fire on the DNS shapes the services themselves publish?**

`docs/CALIBRATION.md` records that `signup.temp_mail` matched none of the 123 holdout rows labelled
`DISPOSABLE`, and that the two signals added in `1.5.0` to close that gap fired on no holdout domain
at all. Lengthening those tables from the holdout would make every figure it then produced circular.
This directory is the other half of that argument, on the same pattern as `benchmark-bimi/`.

## Why it is not in `benchmark/`

The holdout's `DISPOSABLE` rows are customer domains collected in the wild. Fitting an endpoint, a
token prefix, or an SPF include to those rows would derive the fingerprint tables from the dataset
that then measures them. `Group` in `scripts/benchmark.mts` also accepts only three names, and these
rows are none of them.

The shapes in `shapes.json` are transcribed from provider setup documentation. The collector tests in
`test/signup-collect.test.ts` drive those shapes through `collectSignup` with a stubbed resolver, so
the mechanism is pinned without a network and without any labelled customer domain.

## What would make a live CSV worth adding

A handful of custom domains enrolled with the services themselves, the way `benchmark-bimi/` holds
real VMCs. Those names would go in `abuse.csv` here, collected with

```
npx tsx scripts/signal-audit.mts --collect --benchmark benchmark-disposable
```

and would never be merged into `benchmark/abuse.csv`. Until that enrolment exists, the documented
shapes plus the collector tests are the mechanism test, and they are enough to tell a broken matcher
from one that has not yet met its population.

## Shapes

See `shapes.json`. Each entry names the provider page it was read from, the DNS records that page
tells a customer to publish, and the classification those records must produce. Adding a row to the
fingerprint tables without a corresponding shape is how a guessed address gets in.
