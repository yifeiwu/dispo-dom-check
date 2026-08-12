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
  'museum',
  'aero',
  'coop',
  'travel',
  'post',
  'jobs',

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
  const normalised = host.toLowerCase().replace(/\.$/, '');
  const labels = normalised.split('.');
  for (let i = 0; i < labels.length; i += 1) {
    const candidate = labels.slice(i).join('.');
    if (set.has(candidate)) return candidate;
  }
  return null;
}
