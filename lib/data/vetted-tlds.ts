import { normaliseHostname } from '../hostname';

/**
 * Suffixes whose registration is restricted by an accreditation process rather than a credit card.
 *
 * These are the strongest positive in the model, because the gate is external: government, academic and
 * military suffixes cannot be bulk-registered for an account farm at any price.
 *
 * The list deliberately reaches into second-level academic suffixes across many countries, because the
 * population it protects is institutional mail on national education suffixes, where a mass of
 * sequentially named student addresses is entirely legitimate and would otherwise look like a farm.
 *
 * The entry criterion is the gate, not the connotation. A suffix that merely *reads* as institutional
 * belongs nowhere near this list, because the credit it carries is the largest in the model and the
 * conclusive-legitimacy override is built on top of it. Two entries were removed for failing that test:
 *
 *   - `edu.pl` is one of NASK's functional domains, open to any natural or legal person with no
 *     geographic or institutional restriction and registrable in realtime for a few dollars. It was the
 *     single largest source of abuse in the holdout carrying a vetted suffix, at 23 of 28 such domains,
 *     under names like `2mail.edu.pl` and `admin.edu.pl` that no accreditation process would have
 *     issued. Its pricing is the disposable profile exactly: about $4 to register against $29 to renew.
 *   - `edu.eu.org` sits under `eu.org`, which this codebase already classifies as a free-subdomain
 *     provider in `PROVIDER_SUFFIXES`. A name handed out at no cost cannot also be accreditation-gated,
 *     and the two tables asserting opposite things about the same suffix meant whichever was consulted
 *     last decided a 27-point swing.
 *
 * Before adding a suffix, check that a registrar will not simply sell it. See `docs/SCORING.md`.
 *
 * Four more failed that check while the list was being widened, and they are recorded here rather than
 * silently omitted, because every one of them reads as institutional and the next person to extend this
 * list will reach for them:
 *
 *   - `ac.cn` is `edu.pl` again. CNNIC's implementing rules impose documentary conditions on `gov.cn`,
 *     `edu.cn` and `mil.cn` and name no condition at all for `ac.cn`, which falls under the default
 *     clause admitting any natural person. `edu.cn` is in the list below and `ac.cn` is not, which looks
 *     inconsistent until you read the rule they are both governed by.
 *   - `edu.az` is listed by the `.az` rules themselves among the second-level zones "defined for general
 *     use", beside `com.az` and `pp.az`.
 *   - `edu.do` is described by NIC.DO as usable by "any person, sector or company". Only `gob.do` and
 *     `mil.do` are restricted, and `gob.do` is below.
 *   - `ac.ug` sells at a published annual price with instant activation. The only eligibility claim for
 *     it comes from a reseller's knowledge base rather than from registry policy, which is the wrong
 *     direction for the only evidence to point.
 *
 * Two others are gated but not by accreditation, which is a different failure of the same criterion.
 * `edu.ee` is granted free of charge by email to educational institutions *and* to "education-sector
 * projects", which is the `edu.eu.org` shape: no cost and a scope wide enough to admit anyone who
 * describes themselves well. `edu.dz` accepts a commercial register extract as proof, so its gate is
 * "be a registered business" rather than "be a recognised school".
 *
 * Suffixes that do not exist as delegated zones are also absent, and the plausible-looking spellings
 * are worth knowing: Costa Rica uses `ac.cr` and `ed.cr` rather than `edu.cr`, Tunisia `rnu.tn` and
 * `edunet.tn` rather than `edu.tn`, Kenya `go.ke` rather than `gov.ke`, and Ecuador `gob.ec` rather
 * than `gov.ec`.
 *
 * Three sponsored gTLDs were removed in 1.9.0 for failing the criterion they had been admitted under,
 * which is the `edu.pl` lesson a third time: a suffix earns this credit for the gate it has today, not
 * for the gate it had when it was delegated. Sponsored TLDs have been liberalising steadily and nothing
 * announces it.
 *
 *   - `travel` is now a single boolean EPP parameter, `X-TRAVEL-INDUSTRY=Y`, which the registrar sets.
 *     The pre-registration Unique Identification Number is gone, and the registry's own policy says
 *     authentication "may occur prior to or after name registration, at the discretion of the
 *     Registry".
 *   - `jobs` answers its own FAQ question "can anyone register" with "Yes, any person." Eligibility is
 *     self-attested support for a code of ethics. The registry does review some applications, but what
 *     it checks is that the string matches a trade name, which is not a credential.
 *   - `museum` was reclassified from Sponsored to Community by ICANN in 2017 and its eligibility
 *     widened to include "a Museum enthusiast", of which the registry's FAQ says "no particular proof
 *     is required".
 *
 * The rest of the original block was re-checked in the same pass and all of it holds. `aero` issues an
 * Aviation Community Membership ID against a pilot licence or air operating certificate; DotCooperation
 * holds a first-time `coop` registrant's domain inactive until bylaws or tax records are verified; the
 * UPU publishes every `post` application for thirty days and gives final approval itself. `pharmacy`
 * turns out to have the tightest gate of anything here, and is the counter-example to the three
 * removals above: NABP accredits the organisation against its pharmacy licensure *first*, then issues
 * one cryptographic token per domain name, redeemable for sixty days at an authorised registrar, with
 * reaccreditation required annually and suspension for failing it. There is no path to a `pharmacy`
 * domain that does not begin with a verified licence.
 *
 * Thirteen further candidates were checked and refused, and the pattern across them is worth stating
 * once because it is the whole of the entry test. Almost none of them fails for lacking a policy; they
 * fail on *when* the policy is applied. `ngo` and `ong` have registrants "certify" eligibility and audit
 * only "if PIR receives a claim". `scot`, `gal` and `eus` each say in their own language that community
 * nexus is "subject to post-validation". `cat`'s FAQ asks "Can anyone register a .cat domain?" and
 * answers "Yes." `dentist` and `vet` require only that a registrant "represent" they hold the necessary
 * licences. `doctor` has been open since 2016, `trust` was relaunched unrestricted in 2021, `md` is
 * Moldova's ccTLD marketed at physicians, and `dds` is an open generic holding about two names. `radio`
 * validates against an "intended use statement". `music` is the closest miss and the most instructive:
 * its verification is genuinely mandatory and enforced by suspension, but as of April 2026 a domain is
 * "active and usable immediately" with up to a year to complete it, and a year is several orders of
 * magnitude longer than an account farm needs.
 *
 * `sport`, `versicherung`, `kyoto` and `lifeinsurance` were left out as unresolved rather than refused.
 * `sport`'s registration policy promises case-by-case validation while the registry's own ICANN
 * application describes moving to post-validation and then to random sampling after launch, and the two
 * cannot both be current. `versicherung` does check annually, but admits consultants and "service
 * providers to the insurance industry" without further proof. `kyoto` enforces a Kyoto-prefecture
 * address strictly enough to deny registration, which is a presence requirement rather than an
 * accreditation and belongs in `presence-required-suffixes.ts` if anywhere. `lifeinsurance` has two
 * domains in the entire zone and no retail channel.
 *
 * One quirk is worth knowing about rather than acting on: the `realtor` registry is the registrant of
 * record for every name in its zone and licenses use to NAR members, so RDAP shows the registry and not
 * the firm. That costs nothing here, because nothing in the model credits registrant identity — see the
 * note on the withdrawn public-registrant credit in `signals.ts` — but it would quietly break any future
 * rule that tried to.
 *
 * Two directions were identified and deliberately not taken, recorded so the next reader can weigh them
 * rather than rediscover them.
 *
 * Specification 13 brand TLDs are the stronger of the two on its merits and the weaker in practice.
 * Roughly four to five hundred delegations such as `bmw` and `jpmorgan` are contractually
 * single-registrant, so a name under one can only belong to the brand or its affiliates. That satisfies
 * this file's criterion by construction rather than by verification, which is about as good as the
 * evidence gets. It is left out because the population is wrong for this tool: these zones are used for
 * brand campaigns and almost never for the mail-bearing domain somebody signs up with, so it would add
 * several hundred rows of maintenance, and a list that must track terminations to stay correct, to score
 * a case the service will essentially never be shown. The surrounding signals already handle a genuine
 * corporate domain comfortably. If it is ever added, derive it from ICANN's published Spec 13 register
 * mechanically rather than curating it, which is the opposite of how every other entry here was chosen.
 *
 * Further UK institutional second-level suffixes — `parliament.uk`, `judiciary.uk`, `mod.uk`,
 * `gov.scot`, `gov.wales` — are plausible neighbours of the `nhs.uk` and `police.uk` entries below and
 * are left out only because their registration policies were not read. They are leads, not omissions,
 * and the rule is the one `edu.pl` taught: nothing goes in on how institutional the string sounds.
 */
export const VETTED_SUFFIXES: readonly string[] = [
  // Sponsored and restricted gTLDs.
  'gov',
  'edu',
  'mil',
  'int',
  'bank',
  'insurance',
  'pharmacy',
  'aero',
  'coop',
  'post',

  /*
   * Professionally validated gTLDs, each verified against a named credential held by a named body
   * before the name is activated. The distinction that admits these and rejects the dozen near
   * neighbours checked alongside them is *when* the check happens: a registry that validates after
   * activation, or only on complaint, has sold a name to an account farmer who will have finished
   * with it long before anyone looks.
   *
   * `swiss` is verified by OFCOM, the Swiss federal communications office, against the UID business
   * register before assignment and then published for twenty days for competing claims. Its gate is
   * set by federal ordinance rather than by registry discretion, which is a stronger guarantee than
   * anything else here has.
   *
   * `law` and `abogado` share a registry, a validation agent and a contract clause: the registrar
   * "agrees to sell only to Registrants validated by the Registry, via a third party, as legal
   * professionals", checked against public bar records with a non-refundable fee every year.
   *
   * `cpa` is checked by the AICPA against a licence number and its issuing state board, before
   * allocation. `realtor` is checked against NAR membership at registration, and a lapsed membership
   * forces withdrawal. `creditunion` runs through the same DotCooperation verification pipeline as
   * `coop` above, where a first-time registrant's domain cannot be activated until verification
   * completes.
   *
   * `reit` has the strictest gate found anywhere: Nareit reviews every application to register *or
   * renew*, the registrant must qualify as a REIT under a national REIT regime rather than merely be
   * affiliated with one, terms are one year only, and requalification is required at every renewal.
   */
  'swiss',
  'law',
  'abogado',
  'cpa',
  'realtor',
  'creditunion',
  'reit',

  // Government.
  'gov.uk',
  'gov.au',
  'gov.nz',
  'gov.in',
  'gov.br',
  'gov.za',
  'gov.sg',
  'gov.my',
  'gov.ie',
  'gov.il',
  'gov.pl',
  'gov.it',
  'gov.gr',
  'gov.hk',
  'gov.tw',
  'gov.tr',
  'gob.mx',
  'gob.es',
  'gob.ar',
  'gob.cl',
  'gouv.fr',
  'go.jp',
  'go.kr',
  'go.id',
  'go.th',
  'gc.ca',
  'admin.ch',
  'bund.de',
  'gov.eg',
  'gov.sa',
  'gov.ae',
  'gov.kw',
  'gov.qa',
  'gov.jo',
  'gov.om',
  'gov.iq',
  'gov.ly',
  'gov.sd',
  'gov.ng',
  'gov.gh',
  'go.ke',
  'gov.ua',
  'gov.kz',
  'gov.cn',
  'gov.vn',
  'gov.ph',
  'gov.pk',
  'gov.bd',
  'gov.lk',
  'gov.np',
  'gov.co',
  'gob.pe',
  'gob.ve',
  'gob.do',
  'gob.gt',
  'gob.pa',
  'gob.ec',

  // Academic.
  'ac.uk',
  'sch.uk',
  'edu.au',
  'ac.nz',
  'school.nz',
  'ac.jp',
  'ed.jp',
  'ac.kr',
  'edu.sg',
  'edu.my',
  'edu.in',
  'ac.in',
  'edu.cn',
  'edu.hk',
  'edu.tw',
  'edu.br',
  'edu.mx',
  'edu.ar',
  'edu.co',
  'edu.pe',
  'edu.za',
  'ac.za',
  'edu.pk',
  'edu.bd',
  'edu.np',
  'edu.lk',
  'edu.ph',
  'edu.vn',
  'edu.tr',
  'edu.gr',
  'edu.it',
  'edu.es',
  'ac.ir',
  'ac.il',
  'ac.at',
  'ac.be',
  'ac.th',
  'ac.id',
  'sch.id',
  'sch.ir',
  'edu.moe.bn',
  'edu.bn',
  'k12.tr',
  'edu.eg',
  'edu.sa',
  'ac.ae',
  'edu.kw',
  'edu.qa',
  'edu.jo',
  'edu.lb',
  'edu.om',
  'edu.bh',
  'edu.iq',
  'edu.ly',
  'edu.sd',
  'edu.ng',
  'ac.ke',
  'ac.tz',
  'ac.ma',
  'ac.cy',
  'ac.rs',
  'edu.ua',
  'edu.kz',
  'edu.lv',
  'edu.mm',
  'edu.kh',
  'edu.ec',
  'edu.gt',
  'edu.bo',
  'edu.py',
  'edu.ve',

  // Military and health.
  'mil.uk',
  'mil.au',
  'mil.br',
  'mil.in',
  'nhs.uk',
  'police.uk',
];

const set = new Set(VETTED_SUFFIXES);

/**
 * Matches anywhere in the suffix chain, so a deep institutional subdomain is recognised through the
 * academic suffix several labels up rather than only at the registrable boundary.
 */
export function matchVettedSuffix(host: string): string | null {
  const labels = (normaliseHostname(host) ?? '').split('.');
  for (let i = 0; i < labels.length; i += 1) {
    const candidate = labels.slice(i).join('.');
    if (set.has(candidate)) return candidate;
  }
  return null;
}
