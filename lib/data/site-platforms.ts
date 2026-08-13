/**
 * Website platforms that serve custom domains, and what it takes to confirm one is actually serving.
 *
 * This replaces a table deleted in 1.2.0, and the difference between the two is the whole point. That one
 * classified the destination of an apex CNAME, which is a record the domain writes about itself: pointing
 * a name at Shopify requires no account with Shopify, so the credit priced an intention rather than a
 * purchase. It measured 11 families across the holdout and fired on more legitimate domains than abuse
 * ones, and the DNS query that fed it went with it.
 *
 * What is confirmed here is that the platform answered. A response carrying the markers its edge sets, on
 * a domain resolving into address space the platform publishes for exactly this purpose, is the platform
 * agreeing that the domain belongs to an account it holds. None of the platforms below attaches a custom
 * domain on a free tier, so that agreement is evidence somebody is paying — which is the standing rule
 * for a credit, and the reason this is worth reinstating at all.
 *
 * Nothing here costs a request. `collectSite` already fetches the root page and the address set is
 * already in `DnsFacts`, so detection reads two things the analysis holds by the time it runs.
 */

export type SitePlatform = {
  provider: string;
  /**
   * Response headers the platform's edge sets. A name alone matches on presence, which is the stronger
   * form: `x-shopid` means nothing to anyone but Shopify, so its presence is not something a page author
   * arranges by accident.
   */
  headers: readonly { name: string; value?: string }[];
  /**
   * Substrings in the served HTML, almost always an asset CDN the platform rewrites into the page.
   * Weaker than a header, because a page can link to a platform without being served by it, which is why
   * a body match alone never earns a credit.
   */
  body: readonly string[];
  /**
   * IPv4 ranges the platform documents for customers to point a custom domain at. Present only where the
   * platform answers from its own space: several front their edge with a general-purpose CDN, where the
   * address identifies Cloudflare or AWS rather than the platform, and a range that cannot distinguish
   * the two is worse than none.
   */
  ranges: readonly string[];
  /**
   * Whether attaching a custom domain to this platform requires a paid plan. Only `true` supports a
   * credit, because only then does the platform's agreement imply a purchase.
   *
   * Ghost is the instructive `false`. Ghost Pro is a paid product, but Ghost is also open source and
   * self-hostable, so its markers are consistent with somebody running the software on a rented box for
   * nothing. The fact is still worth reporting and is not worth paying for.
   */
  paidCustomDomain: boolean;
};

export const SITE_PLATFORMS: readonly SitePlatform[] = [
  {
    provider: 'Shopify',
    headers: [{ name: 'x-shopid' }, { name: 'x-shardid' }, { name: 'x-sorting-hat-shopid' }],
    body: ['cdn.shopify.com', 'cdn.shopifycloud.com'],
    // The single /24 its documentation tells every merchant to point an apex A record at.
    ranges: ['23.227.38.0/24'],
    paidCustomDomain: true,
  },
  {
    provider: 'Squarespace',
    headers: [{ name: 'x-contextid' }],
    body: ['static1.squarespace.com', 'assets.squarespace.com'],
    ranges: ['198.185.159.0/24', '198.49.23.0/24'],
    paidCustomDomain: true,
  },
  {
    provider: 'Wix',
    headers: [{ name: 'x-wix-request-id' }, { name: 'server', value: 'pepyaka' }],
    body: ['static.parastorage.com', 'static.wixstatic.com'],
    ranges: ['185.230.63.0/24'],
    paidCustomDomain: true,
  },
  {
    provider: 'Webflow',
    headers: [{ name: 'x-wf-page-id' }, { name: 'x-wf-site-id' }],
    body: ['assets.website-files.com', 'assets-global.website-files.com'],
    // Both documented apex targets. They are anycast rather than a contiguous block, so they are pinned
    // as single addresses rather than widened into a range that would claim more than is published.
    ranges: ['75.2.70.75/32', '99.83.190.102/32'],
    paidCustomDomain: true,
  },
  {
    provider: 'BigCommerce',
    headers: [{ name: 'x-bc-storefront' }],
    body: ['cdn11.bigcommerce.com', 'cdn.bcapp.dev'],
    // Custom domains are served through its own CDN partner, so the address identifies the CDN.
    ranges: [],
    paidCustomDomain: true,
  },
  {
    provider: 'HubSpot',
    headers: [{ name: 'x-hs-cache-config' }, { name: 'x-hs-hub-id' }],
    body: ['js.hs-scripts.com', 'cdn2.hubspot.net'],
    ranges: [],
    paidCustomDomain: true,
  },
  {
    provider: 'Ghost',
    headers: [{ name: 'x-ghost-cache-status' }],
    body: ['ghost.io/assets', 'content.ghost.io'],
    ranges: [],
    paidCustomDomain: false,
  },
  {
    provider: 'Duda',
    headers: [{ name: 'x-duda-site' }],
    body: ['irp.cdn-website.com', 'static.cdn-website.com'],
    ranges: [],
    paidCustomDomain: true,
  },
];

/**
 * How firmly the platform was established, and the two are priced differently on purpose.
 *
 * `served` says the response looked like the platform's. That is worth reporting and is not worth
 * paying for: response headers are whatever a server chooses to send, and an asset reference in the body
 * can be a page merely linking to a platform rather than living on one.
 *
 * `served_and_addressed` adds that the domain resolves into address space the platform publishes for
 * custom domains. That is the half the domain cannot arrange alone — the platform has to route the name,
 * and it routes names attached to accounts — so it is the only tier a credit is placed on.
 */
export type PlatformConfirmation = 'served' | 'served_and_addressed';

export type PlatformMatch = {
  provider: string;
  confirmation: PlatformConfirmation;
  paidCustomDomain: boolean;
  /** What matched, for the evidence string, so a reader is never asked to take the classification on faith. */
  matchedOn: string;
};

function ipToNumber(address: string): number | null {
  const parts = address.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** IPv4 only, which is all any of these platforms publishes an apex target in. */
export function inRange(address: string, cidr: string): boolean {
  const [network, bits] = cidr.split('/');
  const prefix = Number(bits);
  const target = ipToNumber(address);
  const base = ipToNumber(network);
  if (target === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  if (prefix === 0) return true;
  /*
   * Built by arithmetic rather than with `<<`, which operates on signed 32-bit integers: `-1 << 0` is
   * -1 and a /1 mask comes out negative, so the shift form is wrong at exactly the two edges a test
   * would be least likely to cover. `>>> 0` then compares both sides as unsigned.
   */
  const mask = 2 ** 32 - 2 ** (32 - prefix);
  return ((target & mask) >>> 0) === ((base & mask) >>> 0);
}

/**
 * Identifies the platform serving a response, from evidence the analysis already holds.
 *
 * Deliberately a pure function over three plain values rather than something that reads `DomainFacts`,
 * so the table can be tested against recorded response fragments without constructing an analysis or
 * touching the network. Header names are matched case-insensitively, since a caller may pass either a
 * `Headers` object's entries or a stored transcript's plain record.
 *
 * The first platform to match wins. The table has no overlapping fingerprints, and a domain cannot be
 * served by two of these at once, so ordering is not doing any work beyond determinism.
 */
export function detectPlatform(
  headers: Readonly<Record<string, string>>,
  body: string,
  addresses: readonly string[],
): PlatformMatch | null {
  const normalisedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), (value ?? '').toLowerCase()]),
  );
  const haystack = body.toLowerCase();

  for (const platform of SITE_PLATFORMS) {
    const header = platform.headers.find(({ name, value }) => {
      const found = normalisedHeaders.get(name.toLowerCase());
      if (found === undefined) return false;
      return value === undefined || found.includes(value.toLowerCase());
    });
    const bodyMarker = platform.body.find((marker) => haystack.includes(marker));
    if (!header && !bodyMarker) continue;

    const addressed = platform.ranges.some((cidr) =>
      addresses.some((address) => inRange(address, cidr)),
    );

    return {
      provider: platform.provider,
      confirmation: addressed ? 'served_and_addressed' : 'served',
      paidCustomDomain: platform.paidCustomDomain,
      matchedOn: header ? `the ${header.name} response header` : `${bodyMarker} in the served page`,
    };
  }

  return null;
}
