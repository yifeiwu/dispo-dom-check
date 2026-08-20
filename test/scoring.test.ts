import { describe, expect, it } from 'vitest';
import { score } from '@/lib/scoring/score';
import { SIGNALS } from '@/lib/scoring/signals';
import { COMBINATIONS } from '@/lib/scoring/combinations';
import { DEFAULT_CONFIG } from '@/lib/scoring/weights';
import {
  accreditedInstitution,
  checkMailAgreesWithTempMail,
  checkMailBlocksForRejectedReasons,
  checkMailClean,
  checkMailFlagsUnknownMx,
  disposableTokenDomain,
  establishedSmallBusiness,
  farmProfileDomain,
  hostedPlatformDomain,
  inZoneTempMailDomain,
  forwarderDomain,
  modestNewBusiness,
  nothingObserved,
  parkedWithMail,
  platformServedOnlyDomain,
  probedNoWildcardDomain,
  providerSubdomain,
  registrarDefaultFarm,
  selfAssertedRecords,
  tempMailDomain,
  unverifiedBimiDomain,
  verifiedBimiDomain,
  wildcardMxDomain,
  withCheckMail,
  zohoMailDomain,
} from './fixtures';

describe('bands', () => {
  it('places an established small business in the top band despite no modern mail hygiene', () => {
    const result = score(establishedSmallBusiness());
    expect(result.verdict).toBe('established');
    expect(result.legitimacy).toBeGreaterThanOrEqual(80);
  });

  it('places a throwaway-inbox domain in the highest risk band', () => {
    const result = score(tempMailDomain());
    expect(result.verdict).toBe('high_risk');
    expect(result.flags).toContain('disposable');
  });

  it('places the account-farm profile in the highest risk band', () => {
    const result = score(farmProfileDomain());
    expect(result.verdict).toBe('high_risk');
    expect(result.flags).toContain('farm_profile');
    expect(result.flags).toContain('catch_all_capable');
  });

  it('flags an alias forwarder without condemning it, leaving the policy to the consumer', () => {
    const result = score(forwarderDomain());
    expect(result.flags).toContain('forwarder');
    // Penalised, but nowhere near the disposable band: this is a legitimate privacy tool.
    expect(result.legitimacy).toBeGreaterThan(score(tempMailDomain()).legitimacy);
  });

  it('withholds a verdict when almost nothing was observed rather than guessing', () => {
    const result = score(nothingObserved());
    expect(result.verdict).toBe('insufficient_evidence');
    expect(result.confidence).toBeLessThan(DEFAULT_CONFIG.confidence.insufficientThreshold);
  });
});

/**
 * The rule the whole model rests on: penalise only on positive evidence. These assertions are the
 * regression guard for it, because it is the rule a well-meaning weight change is most likely to break.
 */
describe('absence is never a penalty', () => {
  const absences = establishedSmallBusiness();

  it('does not penalise absent DMARC, DNSSEC or vendor records', () => {
    const result = score(absences);
    const penalties = result.signals.filter((signal) => signal.points < 0);
    expect(penalties).toHaveLength(0);
  });

  it('reports an absent heuristic as inapplicable rather than as scoring zero', () => {
    const result = score(absences);
    expect(result.inapplicableSignals.map((signal) => signal.id)).toContain('site.no_address_when_young');
  });

  it('says nothing at all about the absent observations', () => {
    const result = score(absences);
    const reported = result.observations.map((observation) => observation.id);
    expect(reported).not.toContain('mail.dmarc_policy');
    expect(reported).not.toContain('footprint.saas_vendors');
    expect(reported).not.toContain('footprint.dnssec');
  });

  it('discounts correlated absences instead of accumulating them', () => {
    const result = score(absences);
    expect(result.combinations.map((combo) => combo.id)).toContain('combo.correlated_absence');
  });
});

/**
 * The mirror of the rule above, and the reason `1.3.0` exists. Absence is not evidence of a problem,
 * and presence is not evidence of legitimacy unless somebody other than the domain confirms it.
 *
 * Everything listed here is a string a domain publishes in its own zone. None of it is checked against
 * the party it names, so all of it is free to mint, and the model must be indifferent to it. This is
 * the regression guard against a well-meaning change reintroducing a credit an account farmer can buy
 * with a text editor.
 *
 * These now live in `lib/scoring/observations.ts`, where there is no weight to reintroduce: the type
 * carries evidence and a rationale and no way to express points at all. The strongest assertion below
 * is therefore the structural one — that none of them appears in the signal registry — because it
 * fails on the change rather than on the consequence of the change.
 *
 * The list is shorter than the set of credits 1.3.0 withdrew. These are the ones still reported, which
 * is to say the ones riding along in a record already being fetched. BIMI and business services had
 * lookups of their own and so were deleted outright rather than zeroed; see `removed signals stay
 * removed` below.
 */
describe('self-asserted records are reported but never scored', () => {
  const UNVERIFIABLE = [
    'mail.spf_present',
    'mail.dmarc_policy',
    'mail.strict_alignment',
    'mail.subdomain_policy',
    'mail.paid_spf_senders',
    'footprint.saas_vendors',
    'footprint.dkim',
  ];

  it('keeps every one of them out of the scoring registry entirely', () => {
    const scored = SIGNALS.map((signal) => signal.id);
    for (const id of UNVERIFIABLE) {
      expect(scored, `${id} must not be a scoring signal`).not.toContain(id);
    }
  });

  it('scores a domain publishing every unverifiable record exactly as one publishing none', () => {
    expect(score(selfAssertedRecords()).legitimacy).toBe(score(modestNewBusiness()).legitimacy);
  });

  it('still reports and explains each one, since a reader can weigh what the score will not', () => {
    const observations = score(selfAssertedRecords()).observations;
    for (const id of UNVERIFIABLE) {
      const observation = observations.find((entry) => entry.id === id);
      expect(observation, `${id} should still be reported`).toBeDefined();
      expect(observation!.evidence.length, id).toBeGreaterThan(0);
      expect(observation!.rationale.length, id).toBeGreaterThan(0);
    }
  });

  /*
   * Compared before the clamp rather than after it. Record breadth used to count DKIM, vendor
   * verification and business-service records, which were simultaneously earning their own credits in
   * `footprint`; a clamped comparison would report the two profiles as equal even if the trim had been
   * reverted, because the dimension binds at its maximum either way.
   */
  it('does not let self-asserted records widen the record-breadth credit', () => {
    const configurationRaw = (facts: ReturnType<typeof modestNewBusiness>) =>
      score(facts).dimensions.find((entry) => entry.dimension === 'configuration')!.raw;
    expect(configurationRaw(selfAssertedRecords())).toBe(configurationRaw(modestNewBusiness()));
  });

  it('pays the reporting vendor only where the vendor vouched for the domain', () => {
    const vouched = selfAssertedRecords();
    vouched.mail = { ...vouched.mail!, dmarcRuaVerified: true };

    const signal = score(vouched).signals.find((entry) => entry.id === 'mail.commercial_rua');
    expect(signal?.points).toBe(DEFAULT_CONFIG.mail.commercialRua);
    expect(score(vouched).legitimacy).toBeGreaterThan(score(selfAssertedRecords()).legitimacy);
  });

  it('treats an unanswered verification as silence rather than as a refusal', () => {
    // `undefined` is a check that could not run. It withholds the credit, exactly as a refusal does,
    // but it must never cost the domain points relative to naming no vendor at all.
    const unchecked = selfAssertedRecords();
    unchecked.mail = { ...unchecked.mail!, dmarcRuaVerified: undefined };

    const signal = score(unchecked).signals.find((entry) => entry.id === 'mail.commercial_rua');
    expect(signal?.points).toBe(0);
    expect(score(unchecked).legitimacy).toBe(score(modestNewBusiness()).legitimacy);
  });
});

describe('overrides', () => {
  it('floors an accredited, aged, paid-mail domain regardless of the additive total', () => {
    const result = score(accreditedInstitution());
    expect(result.legitimacy).toBeGreaterThanOrEqual(
      DEFAULT_CONFIG.combinations.conclusiveLegitimacyFloor,
    );
    expect(result.combinations.map((combo) => combo.id)).toContain('combo.conclusive_legitimacy');
  });

  it('caps a suspended domain no matter what else it has going for it', () => {
    const suspended = establishedSmallBusiness();
    suspended.registration = { ...suspended.registration!, statuses: ['serverhold'] };
    const result = score(suspended);
    expect(result.legitimacy).toBeLessThanOrEqual(DEFAULT_CONFIG.overrides.registryHoldCap);
    expect(result.flags).toContain('registry_hold');
  });

  it('suppresses registration signals for a platform-issued name', () => {
    const result = score(providerSubdomain());
    const ids = result.signals.map((signal) => signal.id);
    expect(ids).not.toContain('age.first_seen');
    expect(ids).not.toContain('economics.first_year_price');
    expect(result.flags).toContain('provider_subdomain');
  });

  it('does not count inapplicable registration sources against confidence for a platform name', () => {
    // Scoping the verdict to the subdomain is honest; punishing its confidence for that would not be.
    expect(score(providerSubdomain()).confidence).toBeGreaterThanOrEqual(
      DEFAULT_CONFIG.confidence.insufficientThreshold,
    );
  });
});

/**
 * Absence from the price list is reported without being scored, so it needs guarding from both sides: the
 * note has to reach the reader, it must move no points in either direction, and it must stay silent where
 * accreditation already answers the question it raises.
 */
describe('suffixes with no published price', () => {
  const unpricedSuffix = () => {
    const facts = establishedSmallBusiness();
    facts.meta.suffix = 'web.id';
    facts.pricing = { suffix: 'web.id', unpriced: true };
    return facts;
  };

  const reportedIds = (facts: ReturnType<typeof establishedSmallBusiness>) =>
    score(facts).observations.map((entry) => entry.id);

  it('reports the absence as evidence rather than staying silent about it', () => {
    const result = score(unpricedSuffix());
    const observation = result.observations.find(
      (entry) => entry.id === 'economics.unpriced_suffix',
    );
    expect(observation?.evidence).toContain('web.id');
  });

  it('moves no points, because the two explanations for it have opposite signs', () => {
    expect(score(unpricedSuffix()).legitimacy).toBe(score(establishedSmallBusiness()).legitimacy);
  });

  it('lowers confidence instead, since the dimension genuinely returned no price', () => {
    expect(score(unpricedSuffix()).confidence).toBeLessThan(
      score(establishedSmallBusiness()).confidence,
    );
  });

  it('stays silent on an accredited suffix, whose absence has the opposite explanation', () => {
    const result = score(accreditedInstitution());
    expect(result.observations.map((entry) => entry.id)).not.toContain(
      'economics.unpriced_suffix',
    );
    // The accreditation credit is paid once, in the name dimension, which is what makes the note
    // redundant here rather than merely quiet.
    const ids = result.signals.map((signal) => signal.id);
    expect(ids).toContain('name.vetted_suffix');
    expect(ids.filter((id) => id.endsWith('vetted_suffix'))).toHaveLength(1);
  });

  it('stays silent on a platform-issued name, which has no registry price to publish', () => {
    const provider = providerSubdomain();
    provider.pricing = { suffix: 'pages.dev', unpriced: true };
    expect(reportedIds(provider)).not.toContain('economics.unpriced_suffix');
  });
});

describe('combinations', () => {
  it('treats parking with working mail as more than the sum of its parts', () => {
    const result = score(parkedWithMail());
    expect(result.combinations.map((combo) => combo.id)).toContain('combo.parked_with_mx');
    expect(result.flags).toContain('parked');
  });

  it('fires the inbound-without-outbound conjunction on alias-capable mail with no sending identity', () => {
    const result = score(farmProfileDomain());
    expect(result.combinations.map((combo) => combo.id)).toContain('combo.inbound_without_outbound');
  });

  it('recognises CNAME-delegated DKIM as outbound identity', () => {
    const domain = farmProfileDomain();
    domain.mail = {
      ...domain.mail!,
      dkimSelectors: ['selector1'],
      dkimKeys: [
        {
          selector: 'selector1',
          cnameTarget: 'selector1-example._domainkey.example.onmicrosoft.com',
          provider: 'Microsoft 365',
        },
      ],
    };
    const result = score(domain);
    expect(result.observations.map((entry) => entry.id)).toContain('footprint.dkim');
    expect(result.combinations.map((combo) => combo.id)).not.toContain(
      'combo.inbound_without_outbound',
    );
  });

  it('fires only the registrar-default conjunction when all default evidence agrees', () => {
    const result = score(registrarDefaultFarm());
    expect(result.combinations.map((combo) => combo.id)).toContain(
      'combo.registrar_default_profile',
    );
    expect(result.flags).toContain('registrar_default');

    const changed = registrarDefaultFarm();
    changed.registrarDefault = undefined;
    expect(score(changed).combinations.map((combo) => combo.id)).not.toContain(
      'combo.registrar_default_profile',
    );
  });

  it('reaches the farm profile on a suffix that is cheap in perpetuity rather than discounted', () => {
    // Bottom of the price table, renewing near parity, so the renewal ratio says nothing. There was never
    // a real price to pay, which is the same absence of a brake on disposal by another route.
    const perpetuallyCheap = farmProfileDomain();
    perpetuallyCheap.pricing = {
      suffix: 'top',
      registration: 1.63,
      renewal: 4.63,
      renewalRatio: 2.84,
    };
    const result = score(perpetuallyCheap);
    expect(result.signals.map((signal) => signal.id)).not.toContain('economics.renewal_ratio');
    expect(result.combinations.map((combo) => combo.id)).toContain('combo.farm_profile');
  });

  it('spares a cheap national suffix that is merely efficient rather than disposable', () => {
    // The reference false positive for the rule above. This suffix is cheap and renews near parity, but it
    // sits above the bottom tier, and it carries an entire country's small businesses.
    const efficientRegistry = farmProfileDomain();
    efficientRegistry.pricing = { suffix: 'de', registration: 2.9, renewal: 4.07, renewalRatio: 1.4 };
    const result = score(efficientRegistry);
    expect(result.combinations.map((combo) => combo.id)).not.toContain('combo.farm_profile');
    expect(result.flags).not.toContain('farm_profile');
  });

  it('caps the total contribution from all combinations', () => {
    const result = score(farmProfileDomain());
    const total = result.combinations.reduce((sum, combo) => sum + Math.abs(combo.points), 0);
    // The cap is applied to the signed sum, so an individual readout may exceed it while the applied
    // total cannot.
    expect(Math.abs(result.legitimacy)).toBeLessThanOrEqual(100);
    expect(total).toBeGreaterThan(0);
  });
});

/*
 * Signals removed for want of evidence, pinned so a reinstatement has to argue past the measurement
 * rather than past a gap in the tests.
 *
 * Two of them can only be pinned in prose, because the removals took their facts with them. The
 * website-platform credit (1.2.0, 11 families across the holdout, firing on more legitimate domains than
 * abuse ones) and the business-service credit (1.3.0, satisfied by a CNAME or SRV record pointing
 * anywhere at all) each owned the only DNS queries that fed them, so the queries went too and there is
 * no longer a fact to assert about. Their fingerprint tables were the kind that decay silently — the
 * business-service table was discarding every `enterpriseregistration.windows.net` answer it was handed,
 * 36 across 4,760 transcripts — which is the argument against keeping either one warm for a signal
 * nothing weighs.
 */
describe('removed signals stay removed', () => {
  /*
   * Removed because it fired on legitimate domains at eleven times the rate of abuse ones.
   * Pinned here so the penalty is not reintroduced under another name: an unknown destination is the
   * case the old signal was written for, and it is the case most likely to look suspicious again.
   */
  it('does not penalise an off-domain redirect, whatever the destination is', () => {
    for (const target of [
      { host: 'profile.linktr.ee', class: 'social_profile' as const, provider: 'Linktree' },
      { host: 'unclassified.example', class: 'unknown' as const },
    ]) {
      const domain = establishedSmallBusiness();
      domain.site = {
        ...domain.site!,
        finalUrl: `https://${target.host}/`,
        redirectedOffDomain: true,
        redirectTarget: target,
        substantive: false,
        titleMatchesDomain: false,
      };

      const site = score(domain).signals.filter((signal) => signal.dimension === 'site');
      expect(site.filter((signal) => signal.points < 0), target.class).toEqual([]);
    }
  });

  /*
   * The alias-relay penalty was removed after firing on twelve families, none of them abuse. Check-Mail
   * publishes the same classification under `is_email_forwarder`, which is exactly the route a removed
   * signal comes back by: reinstated at full weight, sourced from a third party, under a field name
   * that gives no hint of what it contains.
   */
  it('does not penalise the reputation service\u2019s own forwarder classification', () => {
    const domain = withCheckMail(establishedSmallBusiness(), { forwarder: true });
    const reputation = score(domain).signals.find((signal) => signal.id === 'signup.checkmail');
    expect(reputation?.points).toBe(DEFAULT_CONFIG.checkmail.clean);
  });

  /*
   * The DNSSEC credit is the one removal here that was never about verifiability, so it is the one most
   * likely to be argued back in on its reasoning — which was always sound, and was never the problem.
   * It paid +3 on 5% of abuse families and 6% of legitimate ones. What must stay true is that a
   * validated zone is still reported and still scores nothing, since the fact is free to collect and
   * only the credit was withdrawn.
   */
  it('reports a validated DNSSEC chain without paying for it', () => {
    const signed = establishedSmallBusiness();
    signed.dns = { ...signed.dns!, dnssecValidated: true };
    const unsigned = establishedSmallBusiness();
    unsigned.dns = { ...unsigned.dns!, dnssecValidated: false };

    expect(SIGNALS.map((signal) => signal.id)).not.toContain('footprint.dnssec');
    expect(score(signed).observations.map((entry) => entry.id)).toContain('footprint.dnssec');
    expect(score(signed).legitimacy).toBe(score(unsigned).legitimacy);
  });

  /*
   * The wildcard conjunction shipped at zero for one release and was removed rather than left as a
   * registry entry that fires on 1% of abuse domains to say nothing. Youth and an absent site are
   * already charged elsewhere, which is why it never earned a weight; a reinstatement would be paying
   * for them a third time.
   */
  it('does not charge a second time for youth and no site beside a wildcard MX', () => {
    const result = score(wildcardMxDomain());
    expect(result.combinations.map((combo) => combo.id)).not.toContain(
      'combo.wildcard_mx_young_no_site',
    );
  });

  /*
   * The defect the 1.3.0 removal was about, and the one a future change is likeliest to reintroduce.
   * `mail.bimi` paid +8 for a record beginning with `v=BIMI1` while never fetching the certificate it
   * points at. The record is back and so is the signal, so what has to stay true is that a record whose
   * certificate did not verify — for any reason, including there being none — is worth exactly nothing.
   */
  it('pays nothing for a BIMI record whose certificate did not verify', () => {
    for (const failure of ['no_certificate', 'expired', 'subject_mismatch', 'untrusted_anchor']) {
      const result = score(unverifiedBimiDomain(failure));
      const bimi = result.signals.find((signal) => signal.id === 'mail.bimi');
      expect(bimi?.points, failure).toBe(0);
      expect(result.legitimacy, failure).toBe(score(establishedSmallBusiness()).legitimacy);

      // Charging nothing is only half of it: a reader is owed the reason, in words rather than in the
      // identifier the code uses to branch on.
      expect(bimi?.evidence, failure).not.toMatch(/_/);
      expect(result.observations.find((entry) => entry.id === 'mail.bimi_unverified')?.evidence, failure)
        .not.toMatch(/_/);
    }
  });

  /*
   * A verified certificate is the strongest single fact the model can collect and still scores nothing,
   * because the holdout contained one of them. This pins the weight to the measurement rather than to
   * the reasoning, which is the whole disagreement that removed it the first time.
   */
  it('reports a verified Verified Mark Certificate without paying for it', () => {
    const result = score(verifiedBimiDomain());
    const bimi = result.signals.find((signal) => signal.id === 'mail.bimi');
    expect(bimi?.points).toBe(0);
    expect(bimi?.evidence).toMatch(/DigiCert/);
    expect(result.legitimacy).toBe(score(establishedSmallBusiness()).legitimacy);
  });

  /*
   * The hosted-service credit was removed in 1.2.0 for classifying an apex CNAME, which is a record the
   * domain writes about itself. A response header is the same kind of claim — a server sends whatever it
   * likes — so the served-only tier must never score, whatever the addressed tier is eventually worth.
   */
  it('pays nothing for a platform that only appears to be serving the domain', () => {
    const result = score(platformServedOnlyDomain());
    expect(result.signals.find((signal) => signal.id === 'site.hosted_platform')).toBeUndefined();
    expect(result.observations.map((entry) => entry.id)).toContain('site.platform_served');
    expect(result.legitimacy).toBe(score(establishedSmallBusiness()).legitimacy);
  });

  it('reports a confirmed hosted platform without paying for it', () => {
    const result = score(hostedPlatformDomain());
    expect(result.signals.find((signal) => signal.id === 'site.hosted_platform')?.points).toBe(0);
    expect(result.legitimacy).toBe(score(establishedSmallBusiness()).legitimacy);
  });
});

/**
 * The one source whose answer is a third party's conclusion rather than an observation of the domain,
 * and the one signal that credits a point for finding nothing. Both properties are bounded deliberately,
 * and these are the bounds.
 */
describe('third-party reputation verdict', () => {
  it('credits exactly one point when the service answers and knows nothing against the domain', () => {
    const reputation = score(checkMailClean()).signals.find(
      (signal) => signal.id === 'signup.checkmail',
    );

    // A visible row rather than a silent absence is the entire purpose: the reader can otherwise not
    // distinguish a domain the vendor cleared from one it was never asked about.
    expect(reputation?.points).toBe(1);
    expect(reputation?.evidence).toMatch(/knows nothing against this domain/);
  });

  it('adds the credit on top of a paid tenant rather than losing it to the dimension clamp', () => {
    const signup = score(withCheckMail(accreditedInstitution())).dimensions.find(
      (dimension) => dimension.dimension === 'signup',
    );

    // The reason `clamps.signup.max` moved from 6 to 7 in 1.4.0. Left at 6, the credit would render as
    // a point that never reached the total, on precisely the domains most likely to earn both.
    expect(signup?.clamped).toBe(DEFAULT_CONFIG.signup.paidTenant + DEFAULT_CONFIG.checkmail.clean);
    expect(signup?.clampApplied).toBe(false);
  });

  it('catches a disposable operator this model\u2019s own MX table does not recognise', () => {
    const result = score(checkMailFlagsUnknownMx());

    // The case the source exists for: nothing observable about the domain says this, so without the
    // lookup it scores as an unremarkable young name.
    expect(result.flags).toContain('disposable');
    expect(result.verdict).toBe('high_risk');
  });

  it('absorbs a second disposable verdict into the clamp rather than charging twice for it', () => {
    const both = score(checkMailAgreesWithTempMail());
    const signup = both.dimensions.find((dimension) => dimension.dimension === 'signup');

    // Two sources reaching one conclusion is corroboration, not two problems. Pricing the reputation
    // verdict at `tempMail` means the floor is already reached and the risk tier is absorbed.
    expect(signup?.clamped).toBe(DEFAULT_CONFIG.clamps.signup.min);
    expect(both.legitimacy).toBe(score(tempMailDomain()).legitimacy);
  });

  it('ignores a block recommendation the model has already rejected the reasoning for', () => {
    const result = score(checkMailBlocksForRejectedReasons());
    const reputation = result.signals.find((signal) => signal.id === 'signup.checkmail');

    // `block` is true when a domain is invalid *or* disposable, and deliverability was removed from
    // this model because an account farmer has to receive the verification message. Scoring the
    // vendor's headline field would smuggle that judgement back in.
    expect(reputation?.points).toBe(DEFAULT_CONFIG.checkmail.clean);
    expect(result.flags).not.toContain('disposable');
  });

  it('names the parent when the verdict is about something other than the name asked about', () => {
    const domain = withCheckMail(providerSubdomain(), {
      disposable: true,
      risk: 92,
      baseDomain: 'pages.example',
    });
    const reputation = score(domain).signals.find((signal) => signal.id === 'signup.checkmail');

    // A platform-issued name is answered at its parent, and a -40 attributed to a subdomain that did
    // nothing is a reader being misled rather than informed.
    expect(reputation?.evidence).toContain('answered for pages.example');
  });

  it('cannot move a verdict across a band edge on its own', () => {
    for (const build of [
      establishedSmallBusiness,
      modestNewBusiness,
      farmProfileDomain,
      parkedWithMail,
    ]) {
      const without = score(build());
      const with_ = score(withCheckMail(build()));

      // The bound that makes the exception to penalise-only-on-positive-evidence affordable. If a
      // clean answer ever decides a band, the credit has grown past what it can justify.
      expect(with_.legitimacy - without.legitimacy, build.name).toBeLessThanOrEqual(1);
      expect(with_.verdict, build.name).toBe(without.verdict);
    }
  });
});

describe('explainability', () => {
  it('gives every signal a non-empty rationale and a unique id', () => {
    const ids = new Set<string>();
    for (const signal of SIGNALS) {
      expect(signal.rationale.length, signal.id).toBeGreaterThan(40);
      expect(signal.label.length, signal.id).toBeGreaterThan(0);
      expect(ids.has(signal.id), `duplicate id ${signal.id}`).toBe(false);
      ids.add(signal.id);
    }
  });

  it('gives every combination a non-empty rationale', () => {
    for (const combination of COMBINATIONS) {
      expect(combination.rationale.length, combination.id).toBeGreaterThan(40);
    }
  });

  it('gives every scored signal concrete evidence distinct from its rationale', () => {
    const result = score(farmProfileDomain());
    expect(result.signals.length).toBeGreaterThan(0);
    for (const signal of result.signals) {
      expect(signal.evidence.length, signal.id).toBeGreaterThan(0);
      expect(signal.evidence).not.toBe(signal.rationale);
    }
  });

  it('produces a narrative naming the drivers and what was missing', () => {
    const result = score(establishedSmallBusiness());
    expect(result.narrative.length).toBeGreaterThan(40);
    expect(result.narrative).toContain(String(result.legitimacy));
  });

  /**
   * The declared weight is what `/how-it-works` and `/api/model` publish as a heuristic's worth, so it
   * has to agree with what the heuristic actually pays. Nothing in the type system relates the two.
   */
  it('never scores a signal outside its declared weight', () => {
    for (const build of [
      establishedSmallBusiness,
      tempMailDomain,
      farmProfileDomain,
      registrarDefaultFarm,
      forwarderDomain,
      zohoMailDomain,
      parkedWithMail,
      accreditedInstitution,
      providerSubdomain,
      checkMailClean,
      checkMailFlagsUnknownMx,
      checkMailAgreesWithTempMail,
    ]) {
      for (const scored of score(build()).signals) {
        const weight = SIGNALS.find((signal) => signal.id === scored.id)!.weight(DEFAULT_CONFIG);
        expect(scored.points, scored.id).toBeGreaterThanOrEqual(weight.min);
        expect(scored.points, scored.id).toBeLessThanOrEqual(weight.max);
      }
    }
  });

  it('reads every declared weight from the config rather than restating it', () => {
    const softened = { ...DEFAULT_CONFIG, signup: { ...DEFAULT_CONFIG.signup, tempMail: -5 } };
    const signal = SIGNALS.find((entry) => entry.id === 'signup.temp_mail')!;
    expect(signal.weight(softened)).toEqual({ min: -5, max: -5 });
  });

  it('declares a weight the right way round for every signal', () => {
    for (const signal of SIGNALS) {
      const weight = signal.weight(DEFAULT_CONFIG);
      expect(weight.min, signal.id).toBeLessThanOrEqual(weight.max);
      expect(Number.isFinite(weight.min) && Number.isFinite(weight.max), signal.id).toBe(true);
    }
  });

  it('references only signals that exist from every combination', () => {
    const signalIds = new Set(SIGNALS.map((signal) => signal.id));
    for (const combination of COMBINATIONS) {
      for (const required of combination.requires) {
        expect(signalIds.has(required), `${combination.id} requires unknown ${required}`).toBe(true);
      }
    }
  });
});

/**
 * The recall gap `docs/CALIBRATION.md` records, and the three observations added to close it.
 *
 * The gap is structural rather than a short table: a throwaway-inbox service selling custom domains
 * tells the customer to publish a mail exchanger inside their own zone, so the hostname reveals nothing
 * and no amount of lengthening the provider list would help. Each assertion below pins one of the three
 * routes that do reach it, and the first pins the outcome the whole exercise is for.
 */
describe('disposable capability reached without a provider hostname', () => {
  it('reaches the disposable verdict on a domain whose mail exchanger names its own zone', () => {
    const result = score(inZoneTempMailDomain());
    expect(result.flags).toContain('disposable');
    expect(result.verdict).toBe('high_risk');
  });

  it('names the address rather than the hostname as the reason, since the hostname proves nothing', () => {
    const fired = score(inZoneTempMailDomain()).signals;
    const signal = fired.find((entry) => entry.id === 'signup.temp_mail_endpoint');
    expect(signal?.evidence).toContain('46.62.148.222');
    // The hostname signal must stand aside, or one domain pays the same claim twice.
    expect(fired.map((entry) => entry.id)).not.toContain('signup.temp_mail');
  });

  it('reaches the disposable verdict from an ownership token alone', () => {
    const result = score(disposableTokenDomain());
    expect(result.flags).toContain('disposable');
    expect(result.signals.map((signal) => signal.id)).toContain('signup.disposable_token');
  });

  it('prices both disposable routes off the same weight rather than a second number', () => {
    const softened = { ...DEFAULT_CONFIG, signup: { ...DEFAULT_CONFIG.signup, tempMail: -5 } };
    for (const id of ['signup.temp_mail_endpoint', 'signup.disposable_token']) {
      expect(SIGNALS.find((entry) => entry.id === id)!.weight(softened), id).toEqual({
        min: -5,
        max: -5,
      });
    }
  });

  it('reports a wildcard zone as catch-all capable and names what it means', () => {
    const result = score(wildcardMxDomain());
    expect(result.flags).toContain('catch_all_capable');
    const signal = result.signals.find((entry) => entry.id === 'signup.wildcard_mx');
    expect(signal?.evidence).toContain('mx.example.com');
  });

  it('credits nothing for a zone probed and found not to wildcard', () => {
    const result = score(probedNoWildcardDomain());
    expect(result.signals.map((signal) => signal.id)).not.toContain('signup.wildcard_mx');
    expect(result.flags).not.toContain('catch_all_capable');
    // Not having a capability is the ordinary case, so it must not read as evidence of legitimacy.
    expect(result.legitimacy).toBeGreaterThanOrEqual(score(wildcardMxDomain()).legitimacy);
  });

  it('says nothing at all when the zone could not be probed', () => {
    const unprobed = wildcardMxDomain();
    unprobed.signup = { ...unprobed.signup!, wildcardMx: undefined };
    expect(score(unprobed).legitimacy).toBe(score(probedNoWildcardDomain()).legitimacy);
  });
});

describe('ambiguous free-or-paid mail routing', () => {
  it('does not treat Zoho as free unlimited-alias routing', () => {
    const result = score(zohoMailDomain());
    expect(result.signals.map((signal) => signal.id)).toContain('signup.ambiguous_routing');
    expect(result.signals.map((signal) => signal.id)).not.toContain('signup.free_routing');
    expect(result.combinations.map((combo) => combo.id)).not.toContain('combo.free_routing_young_no_site');
  });

  it('still surfaces catch-all capability so a consumer can apply their own policy', () => {
    expect(score(zohoMailDomain()).flags).toContain('catch_all_capable');
  });
});

describe('determinism and config', () => {
  it('is a pure function of facts and config', () => {
    const input = farmProfileDomain();
    expect(score(input)).toEqual(score(input));
  });

  it('responds to a config change without touching signal code', () => {
    const input = tempMailDomain();
    const baseline = score(input);
    const softened = score(input, {
      ...DEFAULT_CONFIG,
      signup: { ...DEFAULT_CONFIG.signup, tempMail: -5 },
    });
    expect(softened.legitimacy).toBeGreaterThan(baseline.legitimacy);
  });

  it('keeps every dimension inside its configured clamp', () => {
    for (const build of [
      establishedSmallBusiness,
      tempMailDomain,
      farmProfileDomain,
      forwarderDomain,
      parkedWithMail,
      accreditedInstitution,
    ]) {
      for (const dimension of score(build()).dimensions) {
        expect(dimension.clamped).toBeGreaterThanOrEqual(dimension.clamp.min);
        expect(dimension.clamped).toBeLessThanOrEqual(dimension.clamp.max);
      }
    }
  });

  it('reports the model version that produced the score', () => {
    expect(score(establishedSmallBusiness()).modelVersion).toBe(DEFAULT_CONFIG.modelVersion);
  });
});
