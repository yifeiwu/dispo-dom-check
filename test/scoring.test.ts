import { describe, expect, it } from 'vitest';
import { score } from '@/lib/scoring/score';
import { SIGNALS } from '@/lib/scoring/signals';
import { COMBINATIONS } from '@/lib/scoring/combinations';
import { DEFAULT_CONFIG } from '@/lib/scoring/weights';
import {
  accreditedInstitution,
  establishedSmallBusiness,
  farmProfileDomain,
  forwarderDomain,
  modestNewBusiness,
  nothingObserved,
  parkedWithMail,
  providerSubdomain,
  registrarDefaultFarm,
  selfAssertedRecords,
  tempMailDomain,
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

  it('reports those heuristics as inapplicable rather than as scoring zero', () => {
    const result = score(absences);
    const inapplicableIds = result.inapplicableSignals.map((signal) => signal.id);
    expect(inapplicableIds).toContain('mail.dmarc_policy');
    expect(inapplicableIds).toContain('footprint.dnssec');
    expect(inapplicableIds).toContain('footprint.saas_vendors');
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

  it('scores a domain publishing every unverifiable record exactly as one publishing none', () => {
    expect(score(selfAssertedRecords()).legitimacy).toBe(score(modestNewBusiness()).legitimacy);
  });

  it('pays nothing for any one of them individually', () => {
    const signals = score(selfAssertedRecords()).signals;
    for (const id of UNVERIFIABLE) {
      const signal = signals.find((entry) => entry.id === id);
      expect(signal, `${id} should still be reported`).toBeDefined();
      expect(signal!.points, id).toBe(0);
    }
  });

  it('still explains each one, since a reader can weigh what the score will not', () => {
    const signals = score(selfAssertedRecords()).signals;
    for (const id of UNVERIFIABLE) {
      expect(signals.find((entry) => entry.id === id)!.evidence.length, id).toBeGreaterThan(0);
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

  it('reports the absence as evidence rather than treating it as inapplicable', () => {
    const result = score(unpricedSuffix());
    const signal = result.signals.find((entry) => entry.id === 'economics.unpriced_suffix');
    expect(signal?.evidence).toContain('web.id');
    expect(result.inapplicableSignals.map((entry) => entry.id)).not.toContain(
      'economics.unpriced_suffix',
    );
  });

  it('scores it neutrally, because the two explanations for it have opposite signs', () => {
    const result = score(unpricedSuffix());
    const signal = result.signals.find((entry) => entry.id === 'economics.unpriced_suffix');
    expect(signal?.points).toBe(0);
    expect(DEFAULT_CONFIG.economics.unpricedSuffix).toBe(0);
    expect(result.legitimacy).toBe(score(establishedSmallBusiness()).legitimacy);
  });

  it('lowers confidence instead, since the dimension genuinely returned no price', () => {
    expect(score(unpricedSuffix()).confidence).toBeLessThan(
      score(establishedSmallBusiness()).confidence,
    );
  });

  it('stays silent on an accredited suffix, whose absence has the opposite explanation', () => {
    const result = score(accreditedInstitution());
    const ids = result.signals.map((signal) => signal.id);
    expect(ids).not.toContain('economics.unpriced_suffix');
    // The accreditation credit is paid once, in the name dimension, which is what makes the note
    // redundant here rather than merely quiet.
    expect(ids).toContain('name.vetted_suffix');
    expect(ids.filter((id) => id.endsWith('vetted_suffix'))).toHaveLength(1);
  });

  it('stays silent on a platform-issued name, which has no registry price to publish', () => {
    const provider = providerSubdomain();
    provider.pricing = { suffix: 'pages.dev', unpriced: true };
    const ids = score(provider).signals.map((signal) => signal.id);
    expect(ids).not.toContain('economics.unpriced_suffix');
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
    expect(result.signals.map((signal) => signal.id)).toContain('footprint.dkim');
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
      parkedWithMail,
      accreditedInstitution,
      providerSubdomain,
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
