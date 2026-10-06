import { describe, expect, it } from 'vitest';
import { collectSite } from '@/lib/collect/site';
import { preferredMx } from '@/lib/data/mx-match';
import { PARKING_BODY_FINGERPRINTS, PLACEHOLDER_PHRASES } from '@/lib/data/parking-ns';
import { presenceRequirementFor } from '@/lib/data/presence-required-suffixes';
import { matchVettedSuffix } from '@/lib/data/vetted-tlds';
import type { DomainFacts } from '@/lib/facts';
import { score } from '@/lib/scoring/score';
import { DEFAULT_CONFIG } from '@/lib/scoring/weights';
import { establishedSmallBusiness, facts, farmProfileDomain } from './fixtures';
import { page, redirectTo, restoreFetchBetweenTests, stubNetwork } from './helpers/network';

/**
 * The 1.8.0 changes, each of which fixes a place where the model was reading evidence that did not say
 * what it was taken to say. They are gathered in one file because that is the single thing they have in
 * common: none of them retunes a weight, and every one of them removes a reading rather than adding a
 * heuristic.
 *
 * What each test pins is the distinction the fix turns on, not the arithmetic around it. A test that
 * asserted on a total would fail the next time any weight moves, and would then be rewritten to match
 * whatever the new total was, which is a test that can only ever agree with the code.
 */

const fired = (result: ReturnType<typeof score>, id: string) =>
  result.signals.find((signal) => signal.id === id);

describe('a platform-issued tenancy is not judged on the breadth of its zone', () => {
  /**
   * Microsoft publishes the `onmicrosoft.com` zone, so a tenant's name carries mail records and nothing
   * else by construction. Every one of the nine such domains in the holdout took the mail-only penalty,
   * six legitimate and three abuse, and all nine landed in `unclear`. A penalty that fires on every
   * member of a population measures nothing about any member of it.
   */
  const tenancy = (overrides: Partial<DomainFacts['meta']> = {}) =>
    facts({
      meta: {
        domain: 'acme.onmicrosoft.com',
        suffix: 'onmicrosoft.com',
        label: 'acme',
        submittedHost: 'acme.onmicrosoft.com',
        fromEmailAddress: false,
        relayDomain: false,
        analysedAt: new Date().toISOString(),
        providerSuffix: { suffix: 'onmicrosoft.com', provider: 'Microsoft 365', kind: 'tenant' },
        ...overrides,
      },
      dns: {
        a: [],
        aaaa: [],
        ns: ['ns1.bdm.microsoftonline.com'],
        mx: [{ priority: 0, host: 'acme.mail.protection.outlook.com' }],
        txt: ['v=spf1 include:spf.protection.outlook.com -all'],
        wwwExists: false,
        mailHostExists: false,
        dnssecValidated: false,
        resolver: 'primary DoH resolver',
      },
    });

  it('neither penalises the tenancy for being mail-only nor credits it for breadth', () => {
    const result = score(tenancy(), DEFAULT_CONFIG);

    expect(fired(result, 'configuration.record_breadth')).toBeUndefined();
  });

  it('still judges breadth on a name whose own holder published the zone', () => {
    const ordinary = score(
      tenancy({
        domain: 'acme.com',
        suffix: 'com',
        submittedHost: 'acme.com',
        providerSuffix: undefined,
      }),
      DEFAULT_CONFIG,
    );

    expect(fired(ordinary, 'configuration.record_breadth')).toBeDefined();
  });
});

describe('the exchangers a sender will actually try', () => {
  /**
   * The paid-tenancy credit rests on a third party refusing delivery to anyone without a tenancy, and
   * that holds only for the host delivery is attempted at. Scanning the whole set let a backup
   * exchanger buy the credit while the real mailbox sat in front of it.
   */
  it('is the lowest priority value and every tie at it', () => {
    expect(
      preferredMx([
        { priority: 10, host: 'backup.example.net' },
        { priority: 1, host: 'a.example.net' },
        { priority: 1, host: 'b.example.net' },
      ]),
    ).toEqual(['a.example.net', 'b.example.net']);
  });

  it('excludes a paid exchanger sitting behind a preferred one', () => {
    expect(
      preferredMx([
        { priority: 0, host: 'booeki.site' },
        { priority: 1, host: 'smtp.google.com' },
      ]),
    ).toEqual(['booeki.site']);
  });

  it('is empty rather than undefined for a zone with no mail', () => {
    expect(preferredMx([])).toEqual([]);
  });
});

describe('suffixes behind an accreditation gate', () => {
  /**
   * The table's criterion is that a registrar will not simply sell the name. These were missing, and
   * `edu.eg` alone cost four Egyptian Ministry of Education school domains a legitimate verdict.
   */
  it.each(['edu.eg', 'gov.sa', 'ac.ke', 'gob.pe'])('recognises %s', (suffix) => {
    expect(matchVettedSuffix(`school.${suffix}`)).toBe(suffix);
  });

  it('does not recognise a namespace a registrar will sell to anyone', () => {
    expect(matchVettedSuffix('anything.edu.pl')).toBeNull();
  });

  /**
   * Validated against a named credential held by a named body, checked before the name is activated.
   * None of these appears in the holdout, so they ship on the entry criterion rather than on a
   * measurement, which is what that criterion is for.
   */
  it.each(['swiss', 'law', 'abogado', 'cpa', 'realtor', 'creditunion', 'reit'])(
    'recognises the professionally validated .%s',
    (suffix) => {
      expect(matchVettedSuffix(`firm.${suffix}`)).toBe(suffix);
    },
  );

  /**
   * Removed in 1.9.0 for failing the criterion they were admitted under. `.travel` is now a boolean
   * the registrar sets, `.jobs` answers "can anyone register" with "any person", and `.museum` admits
   * a "Museum enthusiast" with no proof required. This is the `edu.pl` lesson a third time: the credit
   * is for the gate a suffix has now, not the one it was delegated with.
   */
  it.each(['travel', 'jobs', 'museum'])('no longer credits the liberalised .%s', (suffix) => {
    expect(matchVettedSuffix(`anything.${suffix}`)).toBeNull();
  });

  it.each(['aero', 'coop', 'post', 'gov', 'edu', 'bank', 'insurance'])(
    'keeps .%s, which was re-checked and holds',
    (suffix) => {
      expect(matchVettedSuffix(`body.${suffix}`)).toBe(suffix);
    },
  );
});

describe('a registry that demands an enforced local presence', () => {
  /**
   * The price penalty infers disposability from cost, and that inference needs the price to be the
   * whole barrier. It is not where holding the name requires something money cannot buy.
   */
  it('exempts the suffix however cheaply it lists', () => {
    expect(presenceRequirementFor('de')?.registry).toBe('DENIC');
    expect(presenceRequirementFor('co.uk')).toBeDefined();
  });

  it('charges a suffix whose only gate is the fee', () => {
    expect(presenceRequirementFor('us')).toBeUndefined();
    expect(presenceRequirementFor('nl')).toBeUndefined();
  });

  /**
   * Exact match rather than a chain walk. A presence requirement is a property of the registry that
   * sold the registrable domain, so a label that merely ends in one of these strings is not covered.
   */
  it('does not match a suffix that only ends with a covered one', () => {
    expect(presenceRequirementFor('example.co.uk')).toBeUndefined();
  });

  it('scores no price penalty on a cheap presence-gated suffix', () => {
    const german = facts({
      meta: {
        domain: 'beispiel.de',
        suffix: 'de',
        label: 'beispiel',
        submittedHost: 'beispiel.de',
        fromEmailAddress: false,
        relayDomain: false,
        analysedAt: new Date().toISOString(),
      },
      pricing: { suffix: 'de', registration: 2.9, renewal: 8.5, renewalRatio: 2.93 },
    });

    expect(fired(score(german, DEFAULT_CONFIG), 'economics.first_year_price')?.points).toBe(0);
  });
});

describe('the cheapness term in the farm conjunction', () => {
  /**
   * It read `fired.has('economics.first_year_price')`, and that signal returns a row for every priced
   * domain, scoring zero where the price is mainstream. So the term was true of any domain with a price
   * at all and the conjunction had three live parts rather than four. It now reads the tier.
   */
  const combo = (profile: DomainFacts) =>
    score(profile, DEFAULT_CONFIG).combinations.find((entry) => entry.id === 'combo.farm_profile');

  it('holds for a suffix at the bottom of the price table', () => {
    expect(combo(farmProfileDomain())).toBeDefined();
  });

  it('does not hold for the same domain at a mainstream price', () => {
    const profile = farmProfileDomain();

    expect(
      combo({ ...profile, pricing: { ...profile.pricing!, registration: 12.5, renewal: 14, renewalRatio: 1.12 } }),
    ).toBeUndefined();
  });

  /**
   * A presence-gated registry is not a disposal route however little it charges, so its price is not a
   * cheapness finding here either. The same exemption the price penalty applies.
   */
  it('does not hold on a cheap suffix that demands an enforced local presence', () => {
    const profile = farmProfileDomain();

    expect(
      combo({
        ...profile,
        meta: { ...profile.meta, domain: 'beispiel.de', suffix: 'de', submittedHost: 'beispiel.de' },
        pricing: { suffix: 'de', registration: 2.9, renewal: 8.5, renewalRatio: 2.93 },
      }),
    ).toBeUndefined();
  });
});

describe('a domain whose mail is a consumer provider', () => {
  /**
   * The class was set by the collector and read by nothing, so GMX and mail.com vanity domains — shared
   * mailboxes with millions of users apiece — were scored as though they were one organisation's name.
   */
  const vanity = facts({
    dns: {
      a: ['203.0.113.10'],
      aaaa: [],
      ns: ['ns1.gmx.net'],
      mx: [{ priority: 10, host: 'mx00.emig.gmx.net' }],
      txt: ['v=spf1 include:_spf.gmx.net -all'],
      wwwExists: true,
      mailHostExists: false,
      dnssecValidated: false,
      resolver: 'primary DoH resolver',
    },
    signup: {
      class: 'consumer_infrastructure',
      selfHosted: false,
      provider: 'GMX',
      matchedHost: 'mx00.emig.gmx.net',
    },
  });

  it('is declined rather than scored', () => {
    expect(score(vanity, DEFAULT_CONFIG).verdict).toBe('out_of_scope');
  });

  it('keeps its signals and its score, because declining a verdict is not hiding the evidence', () => {
    const result = score(vanity, DEFAULT_CONFIG);

    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.legitimacy).toBeGreaterThan(0);
  });

  it('says what it saw', () => {
    const observation = score(vanity, DEFAULT_CONFIG).observations.find(
      (entry) => entry.id === 'signup.shared_mail_infrastructure',
    );

    expect(observation?.evidence).toContain('GMX');
  });

  it('leaves an ordinary domain with an ordinary verdict', () => {
    expect(score(facts(), DEFAULT_CONFIG).verdict).not.toBe('out_of_scope');
  });
});

describe('a placeholder phrase against a page that is plainly a site', () => {
  restoreFetchBetweenTests();

  /**
   * Both tables were one table, and the loose half charged -12 for a substring appearing anywhere in
   * the HTML. Five working sites in the holdout were parked by it, among them an arts nonprofit with an
   * events listing and Namecheap, which matched because selling domains is its business.
   */
  /**
   * Carries navigation, because a page is only substantive if there is somewhere else to go on it.
   * These cases are about which phrase table applies, so the pages have to clear that bar first.
   */
  const body = (title: string, text: string) =>
    new Response(
      `<html><head><title>${title}</title></head><body><nav><a href="/about">About</a><a href="/contact">Contact</a></nav>${text}</body></html>`,
      { status: 200 },
    );

  it('does not park a page with a title and real readable text', async () => {
    stubNetwork(() => body('Duluth Cultural Center', `Coming soon: our winter season. ${'word '.repeat(300)}`));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.substantive).toBe(true);
    expect(site.parked).toBe(false);
  });

  it('parks the same phrase on a page with nothing else on it', async () => {
    stubNetwork(() => body('Coming soon', 'Coming soon'));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.substantive).toBe(false);
    expect(site.parked).toBe(true);
  });

  /**
   * The three genuine parking pages that cleared the substantive bar in the holdout all matched this
   * phrase, which is why the split is between two tables rather than between parked and substantive.
   */
  it('still parks a page that names itself a placeholder, however much text it carries', async () => {
    stubNetwork(() => body('Domain default page', `Domain default page for example.com. ${'word '.repeat(300)}`));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.substantive).toBe(true);
    expect(site.parked).toBe(true);
  });

  it('leaves delegation evidence alone, which no page can answer', async () => {
    stubNetwork(() => page('A real looking site'));

    const site = await collectSite(
      'example.com',
      {
        a: ['203.0.113.10'],
        aaaa: [],
        ns: ['ns1.sedoparking.com'],
        mx: [],
        txt: [],
        wwwExists: false,
        mailHostExists: false,
        dnssecValidated: false,
        resolver: 'primary DoH resolver',
      },
      2_000,
    );

    expect(site.parked).toBe(true);
    expect(site.parkingEvidence).toMatch(/^Delegated to/);
  });

  it('keeps the two tables disjoint, so a phrase cannot be dispositive and weak at once', () => {
    const overlap = PLACEHOLDER_PHRASES.filter((phrase) => PARKING_BODY_FINGERPRINTS.includes(phrase));

    expect(overlap).toEqual([]);
  });

  /**
   * The gate asks whether the *response* is a real page, not whether this domain earns credit for it.
   * Gating it on the credit conflated two unrelated reasons for withholding one, and read a third
   * party's copy as evidence about this name: `mycloaked.id` forwards to Cloaked's own homepage, which
   * carries a "Coming soon" badge on a feature tile, and was parked for it.
   */
  it('does not read a placeholder phrase off a page served by somebody else', async () => {
    stubNetwork((url) =>
      url === 'https://example.com/'
        ? redirectTo('https://elsewhere.com/')
        : body('Elsewhere Inc', `Privacy actions. Coming soon. ${'word '.repeat(300)}`),
    );

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.redirectedOffDomain).toBe(true);
    // Withheld because the page is not this domain's, which is not the same as it being a placeholder.
    expect(site.substantive).toBe(false);
    expect(site.parked).toBe(false);
  });
});

describe('a page with nowhere else to go', () => {
  restoreFetchBetweenTests();

  /**
   * The content credit is for a domain that does something other than receive mail, and a title plus
   * 500 characters describes a farm's landing page as well as a business's homepage. 200 of the 467
   * abuse pages earning it had no internal link at all, against 5 of 72 legitimate ones.
   */
  const flat = (text: string) =>
    new Response(`<html><head><title>Landing</title></head><body>${text}</body></html>`, { status: 200 });

  it('is not substantive, however much text it carries', async () => {
    stubNetwork(() => flat('word '.repeat(400)));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.internalPaths).toBe(0);
    expect(site.substantive).toBe(false);
  });

  it('is substantive once it offers a single internal destination', async () => {
    stubNetwork(() =>
      new Response(
        `<html><head><title>Landing</title></head><body><a href="/contact">Contact</a>${'word '.repeat(400)}</body></html>`,
        { status: 200 },
      ),
    );

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.internalPaths).toBe(1);
    expect(site.substantive).toBe(true);
  });

  /**
   * The escape hatch, for a site whose navigation is assembled by JavaScript the probe does not run.
   * Four of the five legitimate link-free pages in the holdout are in that shape.
   */
  it('is substantive without navigation once the text alone settles it', async () => {
    stubNetwork(() => flat('word '.repeat(4_000)));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.internalPaths).toBe(0);
    expect(site.substantive).toBe(true);
  });

  it('counts destinations rather than anchors, so a repeated nav bar is one place', async () => {
    stubNetwork(
      () =>
        new Response(
          `<html><head><title>Shop</title></head><body>
             <nav><a href="/about">About</a><a href="/about/">About</a><a href="https://example.com/about">About</a></nav>
             <a href="#top">Top</a><a href="mailto:a@example.com">Mail</a><a href="https://facebook.com/x">Us</a>
             <footer><a href="/">Home</a></footer>${'word '.repeat(400)}</body></html>`,
          { status: 200 },
        ),
    );

    const site = await collectSite('example.com', undefined, 2_000);

    // `/about` three ways is one destination; the fragment, the mailto, the off-site link and the
    // domain's own front page are not destinations at all.
    expect(site.internalPaths).toBe(1);
  });
});

describe('placeholder pages that declare themselves', () => {
  restoreFetchBetweenTests();

  /**
   * Found by reading the titles of every stored page the model did not call parked, which the
   * fingerprint list had never been asked about. These were the two most common titles in that set,
   * and 129 of the Hostinger pages were being paid the content credit rather than penalised.
   */
  const titled = (title: string) =>
    new Response(
      `<html><head><title>${title}</title></head><body><a href="/x">x</a>${'word '.repeat(200)}</body></html>`,
      { status: 200 },
    );

  it.each([
    ['Parked Domain name on Hostinger DNS system'],
    ['Parking Page'],
    ['Namecheap Parking Page'],
    ['Your domain is expired'],
    ['Site not found \u00b7 GitHub Pages'],
  ])('parks a page titled %s', async (title) => {
    stubNetwork(() => titled(title));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.parked).toBe(true);
  });

  /**
   * Dropped during the same scan and worth pinning. A bare `default page` drew 19 legitimate hits, and
   * a transient origin failure is not a parked domain.
   */
  it.each([['Default page'], ['502 Bad Gateway'], ['Web server is down']])(
    'does not park a page titled %s',
    async (title) => {
      stubNetwork(() => titled(title));

      const site = await collectSite('example.com', undefined, 2_000);

      expect(site.parked).toBe(false);
    },
  );
});

/**
 * The crawler's answer to a gap every other disposable detector has by construction: all three of the
 * mail-side signals identify a *customer* of a throwaway-inbox service, and a provider's own domain is
 * invisible to them while genuinely holding the age, records and website those facts credit. None of
 * them fires on any of the 123 domains the holdout labels disposable.
 *
 * What is pinned here is the distinction the fingerprint turns on — a service naming itself versus a
 * page discussing the subject — because that is the thing a future edit could quietly break.
 */
describe('a site that names itself a throwaway-inbox service', () => {
  restoreFetchBetweenTests();

  const titled = (title: string, body = 'word '.repeat(200)) =>
    new Response(
      `<html><head><title>${title}</title></head><body><a href="/about">about</a>${body}</body></html>`,
      { status: 200 },
    );

  it.each([
    ['Tempmail IO'],
    ['OpenInbox \u2014 Free Temporary Email & Private Disposable Inbox'],
    ['10Mail V2 - Temporary Email Service'],
    ['Moakt - Temp Mail Disposable'],
    ['Email Sementara Gratis - Temporary Email Indonesia'],
    ['Correos Temporales'],
  ])('reads the declaration out of the title %s', async (title) => {
    stubNetwork(() => titled(title));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.declaredDisposable).toBeTruthy();
  });

  /**
   * The failure mode this signal has to avoid, and the reason only the title is matched. An anti-abuse
   * vendor writes about disposable mail at length; it does not title its homepage after the product.
   * Body matching was measured, tripled the abuse domains recovered, and cost a legitimate page.
   */
  it('ignores a page that merely discusses disposable mail', async () => {
    stubNetwork(() =>
      titled(
        'Acme Security \u2014 Signup Fraud Prevention',
        'Our API detects disposable email and temp mail addresses at signup. '.repeat(20),
      ),
    );

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.declaredDisposable).toBeUndefined();
  });

  it('withholds the alias-forwarder vocabulary the model flags rather than condemns', async () => {
    stubNetwork(() => titled('Cloaked \u2014 Private Email Aliases and Anonymous Email'));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.declaredDisposable).toBeUndefined();
  });

  it('declares itself even where the page is otherwise a placeholder', async () => {
    stubNetwork(() => new Response('<html><head><title>Temp Mail</title></head><body>x</body></html>'));

    const site = await collectSite('example.com', undefined, 2_000);

    expect(site.declaredDisposable).toBe('temp mail');
  });
});

/**
 * The cap separates two questions the additive model had been arbitrating on one axis: whether the
 * domain is a real operation, and whether it mints throwaway addresses. A temp-mail service scores
 * genuine credits for age, records and a working site, so the credits are not wrong — they are
 * answering the other question.
 */
describe('a confirmed disposable provider cannot be argued back up', () => {
  const declaring = () => {
    const profile = establishedSmallBusiness();
    profile.site = { ...profile.site!, title: 'Temp Mail', declaredDisposable: 'temp mail' };
    return profile;
  };

  it('caps a domain that would otherwise clear the legitimate band on its credits', () => {
    const uncapped = score(establishedSmallBusiness(), DEFAULT_CONFIG);
    const capped = score(declaring(), DEFAULT_CONFIG);

    expect(uncapped.legitimacy).toBeGreaterThan(DEFAULT_CONFIG.overrides.disposableCap);
    expect(capped.legitimacy).toBeLessThanOrEqual(DEFAULT_CONFIG.overrides.disposableCap);
    expect(capped.verdict).toBe('high_risk');
  });

  it('is a ceiling rather than an assignment, so ordering below it survives', () => {
    const worse = score(farmProfileDomain(), DEFAULT_CONFIG).legitimacy;

    expect(worse).toBeLessThan(DEFAULT_CONFIG.overrides.disposableCap);
  });

  /**
   * The bug this nearly shipped with. `signup.checkmail` covers the vendor's whole answer and returns a
   * *credit* where the vendor knows nothing against the domain, so keying the cap on that signal having
   * fired would have capped every domain Check-Mail cleared.
   */
  it('does not cap a domain the reputation vendor cleared', () => {
    const cleared = establishedSmallBusiness();
    cleared.checkmail = { disposable: false, risk: 0, block: false, valid: true, forwarder: false };

    const result = score(cleared, DEFAULT_CONFIG);

    expect(result.legitimacy).toBeGreaterThan(DEFAULT_CONFIG.overrides.disposableCap);
    expect(result.verdict).toBe('established');
  });

  it('caps a domain the reputation vendor calls disposable', () => {
    const flagged = establishedSmallBusiness();
    flagged.checkmail = { disposable: true, risk: 90, block: true, valid: true, forwarder: false };

    expect(score(flagged, DEFAULT_CONFIG).legitimacy).toBeLessThanOrEqual(
      DEFAULT_CONFIG.overrides.disposableCap,
    );
  });

  /**
   * Free routing and alias forwarding both fire on ordinary small domains, so capping on them would
   * turn the model's stated policy of flagging alias capability into condemning it.
   */
  it('does not cap free routing or alias forwarding', () => {
    for (const signupClass of ['free_routing', 'forwarder'] as const) {
      const domain = establishedSmallBusiness();
      domain.signup = { class: signupClass, provider: 'a provider', matchedHost: 'mx.example.net', selfHosted: false };

      expect(score(domain, DEFAULT_CONFIG).legitimacy).toBeGreaterThan(
        DEFAULT_CONFIG.overrides.disposableCap,
      );
    }
  });
});
