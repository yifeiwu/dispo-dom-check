/**
 * The only place in the codebase where a weight, threshold, clamp, band boundary or override value is
 * allowed to live.
 *
 * That rule is what makes the model tunable, and it is the easy thing to erode: a single threshold
 * written inline inside a signal means the next person retuning weights will silently miss it. Every
 * signal receives this config and reads its numbers from here.
 *
 * `modelVersion` is returned in every API response and recorded in every fixture, so a score can always
 * be traced to the configuration that produced it.
 */

export type Dimension =
  | 'signup'
  | 'economics'
  | 'age'
  | 'mail'
  | 'configuration'
  | 'site'
  | 'name';

export type Verdict =
  | 'high_risk'
  | 'suspicious'
  | 'unclear'
  | 'probably_legitimate'
  | 'established'
  | 'insufficient_evidence'
  | 'out_of_scope';

/**
 * Widens the literal types that `as const` produces, which is what makes the scheme genuinely tunable.
 *
 * Without this, `ScoringConfig` would type the default weight of a signal as the exact number written
 * below, and passing a retuned config would be a type error. The `as const` is still wanted on the value
 * itself so that nothing mutates the shared default in place.
 */
type Widen<T> = T extends number
  ? number
  : T extends string
    ? string
    : T extends boolean
      ? boolean
      : T;

/** Arrays stay readonly: the scorer only ever reads the config, and a retuned one is built fresh. */
type DeepWiden<T> = T extends readonly (infer U)[]
  ? readonly DeepWiden<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepWiden<T[K]> }
    : Widen<T>;

export type ScoringConfig = Omit<DeepWiden<typeof DEFAULT_CONFIG>, 'verdictBands'> & {
  /** Kept narrow, because a band must name a verdict the rest of the system knows about. */
  readonly verdictBands: readonly { maxScore: number; verdict: Verdict }[];
};

export const DEFAULT_CONFIG = {
  modelVersion: '1.7.0',

  /** Additive evidence starts from a neutral midpoint rather than from zero or from full trust. */
  neutralBase: 50,

  /**
   * Per-dimension clamps, so no single dimension can carry the verdict alone. The primary dimension has
   * the widest negative range because a temp-mail fingerprint genuinely is close to conclusive.
   *
   * Each bound is reachable by some combination of the signals in its dimension. A clamp set beyond what
   * the dimension can actually produce is not a safety margin, it is a bound that never binds, and it
   * hides the fact that the protection was removed the day the last signal reaching it was retired.
   * `economics` is the clear case: with the vetted-suffix credit folded into `name`, nothing in the
   * dimension is positive any more, and a maximum of +4 would have claimed a headroom that no longer
   * exists.
   *
   * `configuration.max` is the one bound set by measurement rather than by reach. The dimension can
   * produce +12, and the cross-validated sweep picked 10 in all five folds, recovering abuse domains from
   * legitimate bands without moving a single legitimate domain into an actionable one. The reason is that
   * its two credits overlap: a domain with wide record breadth is usually also the domain whose title
   * matches its own label, so the pair pays twice for one underlying fact — a maintained site. Bounding
   * the total was preferred to repricing either signal, because each is individually well-behaved and it
   * is only their sum that overstates the case.
   *
   * `mail.max` and `footprint.max` fell in 1.3.0 to follow the credits zeroed out of both dimensions.
   * Leaving them at 14 and 20 would have left two bounds that can never bind, which is the state this
   * comment exists to prevent: a clamp wide enough to look protective over a dimension that can no
   * longer reach it reads as a safety margin while providing none.
   *
   * `signup.max` rose from 6 to 7 in 1.4.0 by the same rule read forwards. `paid_tenant` alone reached
   * the old bound, so the one point `checkmail` credits for a clean reputation answer would have been
   * clamped away on exactly the domains most likely to earn both, and a credit that silently vanishes
   * is worse than no credit: the row still renders, showing a point that never reached the total.
   *
   * `signup.min` is unchanged and now binds far more often, because `checkmail` prices a disposable
   * verdict at `tempMail` and the two fire together. That is the intended arithmetic rather than an
   * oversight — see the note on the reputation block below.
   */
  clamps: {
    signup: { min: -40, max: 7 },
    economics: { min: -18, max: 0 },
    age: { min: -30, max: 20 },
    mail: { min: -6, max: 4 },
    configuration: { min: -10, max: 10 },
    site: { min: -12, max: 6 },
    name: { min: -5, max: 15 },
  } satisfies Record<Dimension, { min: number; max: number }>,

  signup: {
    tempMail: -40,
    /**
     * Moving weight from here into the young-and-siteless conjunction was measured and rejected. It was
     * proposed because free routing accounted for eight of eleven legitimate false positives, but that
     * concentration belonged to the model as it stood before `mail.mx_present` was withdrawn and the
     * bands were re-seated. Against the current bands the remaining false positives are held under the
     * floor by other penalties entirely — parking, imminent expiry, a registry hold — so the trade buys
     * no specificity at all: sweeping the split from -18/-15 to -6/-21 leaves false positives flat at 4
     * of 191 while false negatives climb from 153 to 182 of 982, monotonically. The conjunction is
     * already priced correctly; this signal is carrying its own weight and not the conjunction's.
     *
     * The depth itself was then swept from -12 to -24 under five-fold cross-validation over families, on
     * the enlarged holdout and against the shipped bands. -21 was chosen by all five folds and is the only
     * threshold change in 1.2.0 to survive: it moves abuse domains out of a legitimate band without
     * admitting a single further legitimate one. The move is small and the reason it is small is that this
     * signal was already close to right; what the sweep rules out is the much larger change that ranking
     * alone would have suggested, which was to halve it.
     */
    freeRouting: -21,
    /**
     * Mail exchangers a free unlimited-alias product and a paid mailbox product share.
     *
     * Placed by judgement rather than a sweep: Zoho was in `freeRouting` until the table's own
     * membership test was applied, and putting it back there would re-concentrate false positives
     * on paying small businesses. It is above unmatched (which would drop the free-tier farms) and
     * well below `freeRouting`, and it does not participate in the young-and-siteless conjunction
     * that does most of that class's work. A later holdout that can tell the tiers apart should
     * retune this, not the other way around.
     */
    ambiguousRouting: -8,
    forwarder: -12,
    paidTenant: 6,
    /**
     * A zone that answers with mail exchangers for names nobody created.
     *
     * This is the only weight in the dimension that prices the capability directly rather than
     * inferring it from who runs the mailbox: a wildcard MX means one registration yields an unbounded
     * supply of deliverable addresses, which is the thing the dimension is named for. It is a separate
     * weight rather than a reading of `tempMail` because it is a separate claim — a legitimate operator
     * can wildcard a zone, and several do.
     *
     * Placed at -12 by a 5-fold sweep stratified over families, entered at zero so that every candidate
     * was judged against shipping nothing rather than defending a number chosen first. All five folds
     * picked it, out of sample it admits no further legitimate domain to an actionable band, and it
     * recovers rather more than one abuse family per fold from a legitimate one. That is a small effect
     * honestly reported: the capability appears on about 4% of the population, so it decides few
     * verdicts, and it is kept because the ones it decides cost nothing.
     *
     * The innocent reading was expected to force most of the weight into a youth-and-no-site
     * conjunction, on the pattern `freeRouting` established. The measurement said otherwise: that
     * conjunction was swept over the same folds, stayed at zero in all five, and was removed in the
     * same release it arrived in. See `lib/scoring/combinations.ts`.
     *
     * There is deliberately no weight for the two disposable-equivalent signals beside it. An MX
     * resolving to a published throwaway-inbox endpoint and an ownership token for one of those
     * services in the apex TXT set are both the claim `signup.temp_mail` already makes, reached by a
     * different observation, so both read `tempMail` directly. The reasoning is the one set out for the
     * reputation verdict below: two numbers for one claim drift apart the first time either is
     * retuned, and the drift is invisible because they share a dimension.
     */
    wildcardMx: -12,
  },

  /**
   * The third-party reputation verdict, and the only block in this file never measured against the
   * holdout.
   *
   * Every other number here was placed by an ablation or a cross-validated sweep. These cannot be:
   * the source is metered at a thousand lookups a month against a holdout of several thousand
   * domains, so it is excluded from collection by construction and the audit reports it as
   * `KEEP no data, source never answered`. Anyone retuning these is working from judgement, and
   * should know that rather than assume the usual evidence exists.
   *
   * There is deliberately no weight for the disposable verdict. It is the same claim
   * `signup.temp_mail` makes, from a source that checks more than the MX fingerprint, so the signal
   * reads `signup.tempMail` directly. Two numbers for one claim would drift apart the first time
   * either was retuned, and the drift would be invisible: both are in the same dimension, so the
   * total would still look plausible.
   *
   * Pricing it there has a consequence worth stating, because it is easy to miss and impossible to
   * see from this block alone. At -40 the verdict reaches the `signup` floor on its own, so the risk
   * tiers below only change an outcome when `is_disposable` is false, and a `free_routing` domain the
   * vendor also calls disposable now lands at -40 where it previously sat at -21. An unmeasured
   * signal is therefore changing the effective reach of a measured one.
   */
  checkmail: {
    /** Evaluated in order until one matches. Penalty-only: the bottom tier scores nothing. */
    riskTiers: [
      { atLeast: 90, points: -12 },
      { atLeast: 75, points: -6 },
      { atLeast: 0, points: 0 },
    ],
    /**
     * What a clean answer is worth, and the single exception to the rule that this model penalises
     * only on positive evidence.
     *
     * It is a credit for an absence, which is the thing 1.3.0 spent a release removing. It exists
     * because the alternative was scoring zero, and a zero renders in a collapsed section: a reader
     * would have no way to tell a domain the vendor cleared from one the vendor was never asked
     * about. The point is the price of putting that distinction in the main list.
     *
     * The honest cost, recorded here because it argues against the credit: it lands mainly on domains
     * no feed has caught yet, which is the population this model exists to find. One point cannot
     * move a band, and that bound is the entire reason the exception is affordable. It should not
     * grow.
     */
    clean: 1,
  },

  economics: {
    /** First-year price tiers in USD, evaluated in order until one matches. */
    priceTiers: [
      { under: 2, points: -12 },
      { under: 5, points: -8 },
      { under: 10, points: -2 },
      { under: Infinity, points: 0 },
    ],
    /** Renewal-to-registration ratio, applied only inside the first registration term. */
    renewalRatioHigh: { threshold: 10, points: -6 },
    renewalRatioModerate: { threshold: 5, points: -3 },
  },

  age: {
    /** Evaluated in order until one matches; `underDays` is exclusive of the previous tier. */
    tiers: [
      { underDays: 7, points: -30 },
      { underDays: 30, points: -22 },
      { underDays: 90, points: -14 },
      { underDays: 180, points: -8 },
      { underDays: 365, points: -3 },
      { underDays: 730, points: 4 },
      { underDays: 1825, points: 10 },
      { underDays: 3650, points: 16 },
      { underDays: Infinity, points: 20 },
    ],
    singleYearTerm: -3,
    /** Inside the first term and about to expire: the economics of a single-use registration. */
    expiringUnrenewed: { withinDays: 60, points: -10 },
    registryHold: -25,
    pendingDelete: -10,
  },

  /**
   * Mail posture, scored on the one part of it a third party has to agree to.
   *
   * Six credits here were zeroed in 1.3.0, because none of them is evidence: `p=reject`, `aspf=s`,
   * `sp=reject`, a published SPF record and an SPF `include:` naming a paid platform are all free tag
   * edits the domain writes about itself with nothing checking them. Five of the six remain worth
   * showing beside a verdict and ride along in records fetched anyway, so they are collected as
   * observations, which carry no weight to tune. See `lib/scoring/observations.ts`.
   *
   * A seventh, `bimi`, was deleted outright in 1.3.0. It was the plainest case of the same defect — its
   * rationale priced a Verified Mark Certificate at +8 while the collector only ever checked that the
   * record began with `v=BIMI1` — and unlike the others it cost a DNS query of its own. It is back in
   * 1.6.0 with the certificate actually fetched and verified, at zero; see below.
   *
   * `commercialRua` survives at full weight because RFC 7489 §7.1 makes it verifiable: an external
   * report destination must authorise the domain by publishing a record in the vendor's own zone, so
   * the credit is now paid on that confirmation rather than on the domain naming a vendor.
   */
  mail: {
    commercialRua: 4,
    /**
     * Zero, and for a reason worth separating from the other zeroes in this file. Nothing is wrong with
     * the signal. A verified VMC is the strongest single piece of evidence the model can collect — a
     * registered trademark, proof of control, and about a thousand dollars a year, none of it
     * assertable — and the verification now actually happens.
     *
     * There is simply nothing here to price it with. A census of all 4,698 holdout domains, one TXT
     * query each, found **5 BIMI records, of which exactly 1 pointed at a certificate**: Namecheap.
     * Three of the remaining four are Proton domains and so are one family, and the fifth is an abuse
     * domain publishing a record with no certificate — which is, precisely, the shape the removed
     * signal used to pay for. One domain cannot support a weight; the ten-family rarity gate exists to
     * stop exactly this.
     *
     * A weight fitted here would be fitted to Namecheap. So it ships at zero and is reported as an
     * observation, and the number that would price it has to come from a population that publishes
     * some — which a holdout that is 94% generated abuse domains was never going to be.
     */
    bimi: 0,
    /** The only negatives are affirmative misconfigurations, never absence. */
    spfPermitAll: -4,
    liveSiteWithoutSpf: -3,
  },

  configuration: {
    /** Points per configured record class, up to the dimension clamp. */
    recordBreadthPerClass: 2,
    /** Mail configured and nothing else at all: a domain that exists only to receive. */
    mailOnlyZone: -10,
    titleMatchesDomain: 4,
  },

  /*
   * There is no organisational-footprint block any more, and no dimension either.
   *
   * It was built on the premise that a verification record is "the residue of someone completing a
   * domain-verification step inside a paid product". The residue turned out to be indistinguishable
   * from the thing itself: the vendor census matches a TXT prefix, no vendor offers any way to confirm
   * a token it issued, and five invented strings earned the top tier. DKIM keys are free to generate.
   * Both were demoted to observations in 1.3.0, and the business-service tiers were deleted outright
   * along with the six DNS queries per analysis that fed them.
   *
   * `dnssec: 3` was the last member and survived those removals, because the objection that took the
   * others does not touch it: the resolver validated the chain to the root, so it is somebody else's
   * arithmetic and cannot be asserted away. 1.5.0 removed it on a measurement instead. It fired on 5%
   * of abuse families and 6% of legitimate ones with a lift interval spanning 1.00, and taking it out
   * left AUC unchanged while removing two abuse domains from a legitimate band. A credit that pays
   * both classes at the same rate is not a credit, whatever its reasoning says.
   *
   * Per domain rather than per family it is worse than flat: 16% of abuse names against 6% of
   * legitimate. The cheap bulk namespaces carry it — `.cfd` at 47% and `.id` at 39% of 1,548 domains,
   * against 4% for `.com` — because their registrars enable DNSSEC by default. Enabling it stopped
   * being a decision the registrant makes, so the price was being paid for a checkbox somebody else
   * ticked. That is the general hazard with any credit for a capability: it holds only for as long as
   * the capability costs the registrant something.
   *
   * The dimension went with it rather than being left empty, on the rule stated at the clamps above: a
   * bound over a dimension that cannot reach it reads as protection while providing none, and a
   * dimension with no signals is the same defect one level up — it sums to zero on every domain and
   * renders as a row that always says nothing.
   */

  site: {
    substantiveContent: 6,
    /**
     * Zero, chosen by the sweep in 5 of 5 folds, and two independent findings say the same thing.
     *
     * The scored tier fires on **6 domains of 4,698, all legitimate and no abuse**. Nothing is wrong
     * with the precision; there is simply not enough of it to price. Six families is below the
     * ten-family rarity gate the audit applies to every signal, and a weight fitted to six domains is
     * fitted to those six domains.
     *
     * It would also be invisible if placed. Every one of the six serves a real website — necessarily,
     * since a platform is serving it — so `substantiveContent` at +6 has already reached the +6
     * `clamps.site.max` before this is added, and every point of it is clamped away. Raising the clamp
     * to make room was rejected: the two credits are one fact seen twice, that somebody built and pays
     * for a site, and widening a bound to charge twice for it is what the bound is for.
     *
     * So the entry ships at zero rather than being deleted, on the `signup.max` precedent above: the
     * collection costs nothing, the fact is reported as an observation, and a later collection with
     * more small-business domains can price it without rebuilding anything. What it must not do is
     * carry a number nothing supports.
     */
    hostedPlatform: 0,
    parked: -12,
    noAddressWhenYoung: { underDays: 30, points: -6 },
  },

  name: {
    templateDigits: -5,
    vettedSuffix: 15,
  },

  combinations: {
    /** Total magnitude all combinations together may contribute. */
    totalCap: 40,
    farmProfile: -25,
    freeRoutingYoungNoSite: { maxAgeDays: 90, points: -15 },
    /*
     * There is no `wildcardMxYoungNoSite` key. It existed for one release at zero points and was
     * removed with the conjunction it priced; `lib/scoring/combinations.ts` carries the measurement and
     * the reason.
     */
    inboundWithoutOutbound: -10,
    parkedWithMx: -8,
    registrarDefaultProfile: { maxAgeDays: 90, points: -8 },
    /*
     * There is deliberately no scale for the correlated-absence group.
     *
     * It was 0.3, and it was the discount that kept absent DMARC, absent DNSSEC and a zero vendor
     * census from accumulating into a verdict against an unsophisticated small business. Nothing has
     * scaled since 1.3.0 zeroed those credits, because a discount multiplies points and there are no
     * longer any points on that group to multiply. The value was left behind reading like a live
     * protection while multiplying nothing, which is the same defect as a clamp that can never bind:
     * it hides that the protection was removed the day its last input went to zero. What replaced it
     * is stronger than a discount and needs no tuning — those absences are not charged at all. The
     * combination still fires and still reports itself, so a reader can see the conjunction was
     * noticed and deliberately not held against the domain.
     */
    /** A vetted suffix plus real age plus a paid mail tenant floors the score. */
    conclusiveLegitimacyFloor: 80,
    conclusiveLegitimacyMinAgeDays: 730,
  },

  confidence: {
    /**
     * Relative coverage weights per source group. Confidence is the share of the applicable weight that
     * answered, so these are read as ratios and need not sum to any particular total.
     */
    weights: {
      /** The registration record, whichever protocol produced it. */
      registration: 30,
      dnsAndMail: 25,
      signup: 20,
      site: 10,
      pricing: 10,
    },
    /** A genuine contradiction is surfaced rather than averaged away. */
    conflictPenalty: 15,
    /** Below this, the verdict becomes `insufficient_evidence` whatever the band says. */
    insufficientThreshold: 40,
  },

  /**
   * Band boundaries, positioned from the measured distributions of a labelled holdout rather than chosen
   * for roundness. See `docs/CALIBRATION.md`.
   *
   * The first attempt used even twenty-point bands, which put the median abuse domain in `unclear` and so
   * gave a consumer nothing to act on for half the abuse population. The crossover between the two
   * distributions sits near 55, so `unclear` is now a narrow band around it and the two decisive bands are
   * widened to match where the labels actually fall.
   *
   * The floor was 58 until `mail.mx_present` was removed. Withdrawing a flat +2 from the 97% of legitimate
   * domains that have mail moved the whole distribution down with it, and the boundary had to follow or it
   * would have silently become a stricter threshold than the one that was measured: held at 58 it keeps
   * 81.6% of legitimate domains in a legitimate band, against 93.4% here. The band moved, not the
   * operating point.
   *
   * The lower edge of `unclear` stays at the neutral base of 50 on purpose, so that a domain with no
   * evidence either way lands in `unclear` by construction rather than by arithmetic.
   */
  /**
   * Three of the four edges moved in 1.3.0, because zeroing the self-asserted credits took the top off
   * the legitimate distribution: its median fell from 80 to 68 and its tenth percentile from 56 to 46.
   * Bands calibrated against a scale where an ordinary business could reach 100 do not survive a change
   * that caps it near 86, and leaving them would have quietly doubled the false-positive rate rather
   * than holding the operating point the model has always been tuned to.
   *
   * 55 is unchanged and is still where the two distributions cross, at a Youden J of 0.687 against
   * 0.689 for its nearest neighbour. That it survived a change this large is the strongest evidence
   * any edge here has.
   *
   * 39 is the ceiling on the actionable bands, down from 49, and it is placed by the false-positive
   * budget rather than by separation: 5.2% of legitimate domains fall below 40, which is the same rate
   * `1.1.0` and `1.2.0` shipped. Holding it at 49 would have taken 12%. The recall this costs is small,
   * at 66.6% of abuse in an actionable band against 70.3% before.
   *
   * 18 is where `high_risk` stops taking more than 2% of legitimate domains, down from where 24 now
   * sits at 2.8%. This is the one boundary where being wrong means blocking somebody real, so it takes
   * the measured limit rather than a margin past it.
   *
   * 70 is two points above the lowest floor at which `established` still holds abuse under 2% of its
   * class, which the sweep puts at 68. Left at 80 it would have admitted a quarter of legitimate
   * domains where it used to admit half.
   *
   * The lower edge of `unclear` is no longer pinned to the neutral base of 50. What that pin protected
   * still holds — a domain with no evidence either way scores 50 and lands in `unclear` by
   * construction — but the edge itself is now placed by the false-positive budget, because a scale with
   * less positive evidence available puts ordinary domains below the base without that being evidence
   * against them. `unclear` is correspondingly wide, and that is the honest result rather than a
   * defect: the model deleted the evidence it had been using to be confident about legitimate domains,
   * and the band that says so is where that uncertainty belongs.
   *
   * Read those figures as per-class rates, never as the composition of a band. The holdout carries about
   * twenty abuse domains for every legitimate one by construction, so every band in it looks
   * predominantly abusive whatever the boundaries are.
   */
  verdictBands: [
    { maxScore: 18, verdict: 'high_risk' },
    { maxScore: 39, verdict: 'suspicious' },
    { maxScore: 54, verdict: 'unclear' },
    { maxScore: 69, verdict: 'probably_legitimate' },
    { maxScore: 100, verdict: 'established' },
  ],

  overrides: {
    /** Registry suspension is the only hard cap, since no external verdict remains to defer to. */
    registryHoldCap: 10,
  },
} as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
