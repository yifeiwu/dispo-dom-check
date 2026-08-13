# BIMI verification set

Forty-two large brands, kept deliberately apart from `benchmark/`. Nothing here is scored, nothing here
enters a calibration figure, and it exists to answer one question the holdout cannot: **does the VMC
verifier accept certificates that are actually genuine?**

The fixture tests in `test/bimi-vmc.test.ts` prove every rejection path with certificates generated
locally. They cannot prove the opposite, because a certificate generated locally is not a real VMC — no
fixture demonstrates that the verifier accepts a chain issued by DigiCert with the extensions a real VMC
carries. A verifier that rejects everything would pass that entire suite. This directory is the other
half of the argument.

## Why it is not in `benchmark/`

Two reasons, and either alone would be enough.

`Group` in `scripts/benchmark.mts` accepts three names, and these rows are none of them. More
importantly, adding forty of the largest brands on the internet to `benchmark/legitimate.csv` would
change the population every calibration figure is computed over. That file holds 212 families of
ordinary small businesses, schools and regional providers, which is what makes it a hard test: telling a
village dentist from a domain farm is the problem worth solving. Telling `paypal.com` from a domain farm
is not, and forty domains like these would flatter every number in `docs/CALIBRATION.md` without
improving the model at all.

`loadCache` filters to the rows it was pointed at, so collecting this directory leaves the main audit
untouched.

## Running it

```
npx tsx scripts/signal-audit.mts --collect --benchmark benchmark-bimi
npx tsx scripts/bimi-anchors.mts
```

The second script reads the collected certificates and prints the public-key fingerprints they chain up
to, which is where the entries in `lib/data/bimi-authorities.ts` come from. They are derived from
observation across many independent brands rather than transcribed from documentation: a key that
DigiCert used to sign certificates for a dozen unrelated large companies is a Mark Verifying Authority
key, and that argument does not depend on trusting any single one of them.

## Selection

Brands widely reported to display BIMI logos in Gmail and Apple Mail. It is a convenience sample and is
not claimed to be otherwise — several will publish no record, and that is fine. The set only has to
contain enough genuine certificates to exercise the accepting path and to agree on the anchors.
