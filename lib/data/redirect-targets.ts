export type RedirectTargetClass = 'parking' | 'hosted_destination' | 'social_profile' | 'unknown';

type RedirectPattern = {
  pattern: string;
  provider: string;
  class: Exclude<RedirectTargetClass, 'unknown'>;
};

const REDIRECT_PATTERNS: readonly RedirectPattern[] = [
  { pattern: 'sedo.com', provider: 'Sedo', class: 'parking' },
  { pattern: 'afternic.com', provider: 'Afternic', class: 'parking' },
  { pattern: 'dan.com', provider: 'Dan.com', class: 'parking' },
  { pattern: 'hugedomains.com', provider: 'HugeDomains', class: 'parking' },
  { pattern: 'parkingcrew.net', provider: 'ParkingCrew', class: 'parking' },
  { pattern: 'bodis.com', provider: 'Bodis', class: 'parking' },
  { pattern: 'linktr.ee', provider: 'Linktree', class: 'social_profile' },
  { pattern: 'beacons.ai', provider: 'Beacons', class: 'social_profile' },
  { pattern: 'instagram.com', provider: 'Instagram', class: 'social_profile' },
  { pattern: 'facebook.com', provider: 'Facebook', class: 'social_profile' },
  { pattern: 'linkedin.com', provider: 'LinkedIn', class: 'social_profile' },
  { pattern: 'youtube.com', provider: 'YouTube', class: 'social_profile' },
  { pattern: 'github.com', provider: 'GitHub', class: 'social_profile' },
  { pattern: 'notion.site', provider: 'Notion', class: 'hosted_destination' },
  { pattern: 'substack.com', provider: 'Substack', class: 'hosted_destination' },
  { pattern: 'medium.com', provider: 'Medium', class: 'hosted_destination' },
  { pattern: 'etsy.com', provider: 'Etsy', class: 'hosted_destination' },
  { pattern: 'myshopify.com', provider: 'Shopify', class: 'hosted_destination' },
];

function suffixMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

export function classifyRedirectTarget(host: string): {
  class: RedirectTargetClass;
  provider?: string;
} {
  const normalised = host.toLowerCase().replace(/\.$/, '');
  const match = REDIRECT_PATTERNS.find(({ pattern }) => suffixMatches(normalised, pattern));
  return match ? { class: match.class, provider: match.provider } : { class: 'unknown' };
}
