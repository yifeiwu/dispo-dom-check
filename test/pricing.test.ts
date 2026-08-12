import { describe, expect, it } from 'vitest';
import { PRICING_SNAPSHOT_DATE, collectPricing } from '@/lib/collect/pricing';

/**
 * The price snapshot is committed data feeding a scored dimension, so these tests guard the two things a
 * refresh can break: the file still parses into the expected shape, and the suffix lookup still resolves.
 * They assert on relationships rather than on prices, which move.
 */
describe('collectPricing', () => {
  it('reports a snapshot date, so staleness is visible', () => {
    expect(PRICING_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('prices a mainstream suffix at parity between registration and renewal', () => {
    const { facts } = collectPricing('com');
    expect(facts.registration).toBeGreaterThan(5);
    expect(facts.renewalRatio).toBeLessThan(2);
    expect(facts.unpriced).toBeUndefined();
  });

  it('derives a high renewal ratio for a suffix that discounts the first year', () => {
    const { facts } = collectPricing('xyz');
    expect(facts.registration).toBeLessThan(5);
    expect(facts.renewalRatio).toBeGreaterThan(2);
  });

  it('never infers a second-level suffix price from its parent', () => {
    // The parent is the wrong bound: a registry's second-level namespaces undercut its base ccTLD, so
    // inheriting the parent reads a cheap suffix as a mainstream one and suppresses the penalty.
    const { facts } = collectPricing('not-a-real-suffix.com');
    expect(facts.unpriced).toBe(true);
    expect(facts.registration).toBeUndefined();
    expect(facts.renewalRatio).toBeUndefined();
  });

  it('treats a zero-priced entry as unpriced rather than free', () => {
    // The feed lists a handful of closed brand TLDs at 0, meaning it does not sell them. Parsed as a
    // price, zero is the cheapest figure in the file and takes the heaviest penalty in the dimension.
    const { facts } = collectPricing('fly');
    expect(facts.unpriced).toBe(true);
    expect(facts.registration).toBeUndefined();
    expect(facts.renewalRatio).toBeUndefined();
  });

  it('records an unknown suffix as unpriced rather than cheap', () => {
    const { facts } = collectPricing('invalid');
    expect(facts.unpriced).toBe(true);
    expect(facts.registration).toBeUndefined();
  });
});
