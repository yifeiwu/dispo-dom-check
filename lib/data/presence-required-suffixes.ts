/**
 * Suffixes whose registry requires the registrant to have a presence in its territory, and enforces it.
 *
 * This table exists to answer one question and nothing else: whether a low list price means what the
 * economics dimension assumes it means. That signal prices disposability — "at the bottom of the price
 * range an operator buys seven domains for the price of one, so a very cheap suffix lowers the cost of
 * disposing of a domain after a single use" — and the inference holds only where the price is the whole
 * barrier. Where a registry also demands an address it can serve notice at, a verified national
 * identifier, or an establishment inside its territory, the cheap price buys an operator nothing,
 * because the thing standing between them and ten thousand names was never the money.
 *
 * `.de` is the case that forced it. DENIC lists at about $2.90, which is the second-deepest penalty tier
 * in the model at -8, and it is cheap because DENIC is a non-profit co-operative running the second
 * largest ccTLD in the world at cost — not because it is selling throwaway names. 18 of the 212
 * legitimate holdout domains sit under it, against 4 abuse domains, and 17 of the 18 scored exactly 50
 * and landed in `unclear`: the -8 cancelled their record breadth precisely, and `.de` publishes no
 * registration date so there was no age credit to make it back with. The model was charging a whole
 * national small-business population for the efficiency of its registry.
 *
 * The criterion is enforcement, not geography, and the distinction is the entire value of the table.
 * `.us` is deliberately absent despite having a Nexus policy, because that policy is self-certified at
 * registration and nothing checks it; a requirement nobody verifies is not a barrier, and `.us` carries
 * 33 abuse domains and no legitimate one in the holdout. `.nl`, `.be`, `.ch`, `.at`, `.se`, `.pl` and
 * `.es` are absent because they ask for nothing at all. Before adding a suffix, establish that the
 * registry will cancel or suspend a name whose registrant cannot produce the presence it demands.
 *
 * Measured, under `A1` in the sweep that chose this: legitimate domains in a legitimate band rise from
 * 161 to 181 of 212, `unclear` falls from 44 to 24, no further legitimate domain enters an actionable
 * band, and exactly one abuse domain enters a legitimate one — `parfumskaufen.de` at 48 to 56. That is
 * the honest cost and it is one domain against twenty.
 */
export type PresenceRequirement = {
  suffix: string;
  /** The body that imposes it, named in the evidence string a reader sees. */
  registry: string;
  /** What the registrant has to produce, stated so the credit can be argued with. */
  requirement: string;
};

export const PRESENCE_REQUIRED_SUFFIXES: readonly PresenceRequirement[] = [
  {
    suffix: 'de',
    registry: 'DENIC',
    requirement: 'an administrative contact resident in Germany, on pain of deletion',
  },
  /*
   * All four Nominet namespaces, because Nominet's requirement does not distinguish between them: a
   * registrant must supply a UK address for service and the name is suspended if they cannot. Listing
   * `.co.uk` and omitting bare `.uk` would be fitting the table to the holdout rather than to the
   * policy, and the holdout agrees either way — including all four is the better measurement as well as
   * the more defensible rule.
   */
  { suffix: 'uk', registry: 'Nominet', requirement: 'a UK address for service, enforced by suspension' },
  { suffix: 'co.uk', registry: 'Nominet', requirement: 'a UK address for service, enforced by suspension' },
  { suffix: 'org.uk', registry: 'Nominet', requirement: 'a UK address for service, enforced by suspension' },
  { suffix: 'me.uk', registry: 'Nominet', requirement: 'a UK address for service, enforced by suspension' },
  {
    suffix: 'eu',
    registry: 'EURid',
    requirement: 'residency or establishment inside the EU, verified and revocable',
  },
  {
    suffix: 'fr',
    registry: 'AFNIC',
    requirement: 'an address inside the EU, verified on challenge',
  },
  {
    suffix: 'it',
    registry: 'Registro .it',
    requirement: 'EU presence and a signed declaration of responsibility',
  },
  {
    suffix: 'ca',
    registry: 'CIRA',
    requirement: 'one of the Canadian Presence Requirements, checked at registration',
  },
  /*
   * The rest are listed for the policy rather than for a price. None of them appears in the committed
   * price snapshot, so none of them is taking a penalty today and removing one changes no score. They
   * are here because the table is a statement of which registries gate on presence, and a suffix that
   * enters the snapshot later should not need this reasoning done again under time pressure.
   */
  { suffix: 'no', registry: 'Norid', requirement: 'a Norwegian organisation number, with a 100-domain cap' },
  { suffix: 'dk', registry: 'DK Hostmaster', requirement: 'a verified identity or CVR company number' },
  { suffix: 'fi', registry: 'Traficom', requirement: 'a Finnish business ID or verified personal identity' },
  { suffix: 'is', registry: 'ISNIC', requirement: 'an Icelandic kennitala' },
  { suffix: 'hu', registry: 'Hungarian registry', requirement: 'Hungarian presence and supporting documents' },
  { suffix: 'co.jp', registry: 'JPRS', requirement: 'a registered Japanese corporation, one domain each' },
  { suffix: 'or.jp', registry: 'JPRS', requirement: 'an incorporated Japanese non-profit' },
  { suffix: 'ne.jp', registry: 'JPRS', requirement: 'a licensed Japanese network service provider' },
  {
    suffix: 'com.au',
    registry: 'auDA',
    requirement: 'an ABN or ACN verified against the Australian Business Register',
  },
  { suffix: 'net.au', registry: 'auDA', requirement: 'an ABN or ACN verified against the Australian Business Register' },
  { suffix: 'org.au', registry: 'auDA', requirement: 'an ABN or ACN verified against the Australian Business Register' },
  { suffix: 'com.vn', registry: 'VNNIC', requirement: 'Vietnamese business registration documents' },
  { suffix: 'com.sg', registry: 'SGNIC', requirement: 'an ACRA business registration' },
  { suffix: 'com.my', registry: 'MYNIC', requirement: 'Malaysian business registration' },
  { suffix: 'com.hk', registry: 'HKIRC', requirement: 'a Hong Kong business registration certificate' },
  { suffix: 'co.th', registry: 'THNIC', requirement: 'Thai company registration' },
  { suffix: 'co.kr', registry: 'KISA', requirement: 'Korean business registration' },
];

const byStr = new Map(PRESENCE_REQUIRED_SUFFIXES.map((entry) => [entry.suffix, entry]));

/**
 * Exact suffix match, not a chain walk.
 *
 * `matchVettedSuffix` walks the chain because an accreditation gate several labels up still describes
 * the name under it: a school's host beneath `ac.uk` is reached through its institution. A presence
 * requirement is a property of the *registry* that sold the registrable domain, so the only suffix that
 * can carry it is the one the registration was made at. Walking the chain here would exempt
 * `anything.co.uk.example.com` on the strength of a suffix no registry issued.
 */
export function presenceRequirementFor(suffix: string): PresenceRequirement | undefined {
  return byStr.get(suffix.toLowerCase());
}
