import snapshot from '../data/suffix-pricing.json';
import type { PricingFacts } from '../facts';

/**
 * Suffix registration economics, read from a committed snapshot of a no-authentication price feed
 * covering roughly 900 suffixes.
 *
 * This replaces the hand-curated abuse-tier table the design started with. A price list is objective and
 * updates itself when a registry runs a promotion, which is exactly when a suffix becomes attractive for
 * bulk registration.
 *
 * It is a snapshot rather than a live fetch because the feed was measured taking upwards of twelve
 * seconds, which is longer than the entire analysis budget. Fetched per request the dimension never
 * returned data at all, and cached in memory it was still dead on the first request of every process.
 * Suffix prices move on the order of months, so the staleness cost is far smaller than that. Refresh with
 * `npm run refresh:pricing`, which is the only thing allowed to write the snapshot.
 *
 * The derived ratio matters more than the absolute price. An abuser pays only the first year, so a
 * registry discounting year one by a factor of ten is selling disposability, whereas a suffix that renews
 * at parity is selling a domain someone intends to keep.
 *
 * The feed is one registrar's catalogue, so its coverage is the mainstream retail market rather than every
 * suffix in existence. What it omits is reported as `unpriced`, which the scorer surfaces as a note and
 * scores zero: absence means either that the suffix is not openly registrable or that it is sold only by
 * registrars local to its registry, and those deserve opposite signs. Amending the snapshot from other
 * feeds was considered and rejected, because the sources that carry those suffixes are per-country and
 * per-currency, and the Western registrars that do resell them charge an exotic-ccTLD handling premium
 * that is further from the truth than silence.
 */

type PriceEntry = { registration?: string; renewal?: string };

const PRICING = snapshot.pricing as Record<string, PriceEntry>;

/** Reported as the source of this dimension, since that is where the snapshot came from. */
export const PRICING_SOURCE_URL = snapshot.source;
export const PRICING_SNAPSHOT_DATE = snapshot.fetchedAt;

/**
 * Prices are stored as strings exactly as the feed returns them, and premium entries carry thousands
 * separators, which makes a bare `Number` call return NaN and silently drop the signal.
 *
 * Zero is the feed's placeholder for a suffix it lists but does not sell, not a free registration. The
 * only such entry in the snapshot is a closed brand TLD that nobody outside its owner can register at
 * any price; read as a price it would be the cheapest suffix in the file and take the heaviest penalty
 * in the dimension. No registry gives a TLD away any more in any case: the namespaces that once did are
 * either reclaimed by their governments or now charge, and the free names that remain are subdomains
 * issued by a provider, which `PROVIDER_SUFFIXES` covers instead. So a non-positive figure is absence.
 */
function parsePrice(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/,/g, '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function collectPricing(suffix: string): { facts: PricingFacts; sourceUrl: string } {
  // Matched exactly against the full suffix without a leading dot. Falling back to the final label was
  // tried, on the theory that the parent's economics still bound the cost. That is false, and false
  // in the dangerous direction: a registry's second-level namespaces are routinely a fraction of the price
  // of its base ccTLD, so `web.id` inherited `.id` and read as an $18 domain when it retails for a couple
  // of dollars. The inheritance both zeroed the price penalty and asserted a renewal ratio of 1.0 that
  // nothing had measured.
  const entry = PRICING[suffix.toLowerCase()];

  if (!entry) {
    // Absence is now reported as a fact to be scored rather than filled in with a guess.
    return { facts: { suffix, unpriced: true }, sourceUrl: PRICING_SOURCE_URL };
  }

  const registration = parsePrice(entry.registration);
  const renewal = parsePrice(entry.renewal);

  // An entry carrying no usable figure is the same fact as no entry at all, and is reported the same
  // way, rather than being scored as a suffix that costs nothing.
  if (registration === undefined) {
    return { facts: { suffix, unpriced: true }, sourceUrl: PRICING_SOURCE_URL };
  }

  return {
    sourceUrl: PRICING_SOURCE_URL,
    facts: {
      suffix,
      registration,
      renewal,
      renewalRatio: renewal ? Math.round((renewal / registration) * 100) / 100 : undefined,
    },
  };
}
