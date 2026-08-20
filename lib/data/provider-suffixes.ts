/**
 * Suffixes where the name under them was issued by a platform rather than registered at a registry.
 *
 * Registration age, price and registrar all belong to the provider, not to the name being analysed,
 * so those signals are suppressed entirely and the result is marked as scoped to the subdomain. The
 * public suffix list's private section covers most of these and `tldts` reads it, but the PSL is
 * incomplete for free-subdomain and dynamic-DNS providers, which is precisely the population that
 * matters here, so this table supplements it.
 *
 * Suffixes are listed as bare strings because they are matched, not visited.
 */
export type ProviderSuffix = {
  suffix: string;
  provider: string;
  /**
   * `platform` issues names as part of a hosting product, so cost is incidental and the name says
   * little either way. `free_subdomain` hands out names at no cost to anyone who asks, which is the
   * economics signal that the pricing collector would otherwise supply.
   */
  kind: 'platform' | 'free_subdomain' | 'tenant';
  /**
   * True where holding a name under this suffix means someone is paying for a seat, e.g. an
   * `onmicrosoft.com` tenant is a Microsoft 365 customer.
   */
  impliesPaidTenant?: boolean;
  note?: string;
};

export const PROVIDER_SUFFIXES: readonly ProviderSuffix[] = [
  // Tenant identifiers: holding a name here means being a paying customer of the platform.
  {
    suffix: 'onmicrosoft.com',
    provider: 'Microsoft 365 tenant',
    kind: 'tenant',
    impliesPaidTenant: true,
  },
  { suffix: 'sharepoint.com', provider: 'Microsoft SharePoint tenant', kind: 'tenant', impliesPaidTenant: true },
  { suffix: 'myshopify.com', provider: 'Shopify store', kind: 'tenant', impliesPaidTenant: true },
  { suffix: 'atlassian.net', provider: 'Atlassian cloud tenant', kind: 'tenant', impliesPaidTenant: true },
  { suffix: 'zendesk.com', provider: 'Zendesk tenant', kind: 'tenant', impliesPaidTenant: true },
  { suffix: 'salesforce.com', provider: 'Salesforce org', kind: 'tenant', impliesPaidTenant: true },

  // Developer platforms handing out subdomains with a project.
  { suffix: 'pages.dev', provider: 'Cloudflare Pages', kind: 'platform' },
  { suffix: 'workers.dev', provider: 'Cloudflare Workers', kind: 'platform' },
  { suffix: 'vercel.app', provider: 'Vercel', kind: 'platform' },
  { suffix: 'netlify.app', provider: 'Netlify', kind: 'platform' },
  { suffix: 'github.io', provider: 'GitHub Pages', kind: 'platform' },
  { suffix: 'gitlab.io', provider: 'GitLab Pages', kind: 'platform' },
  { suffix: 'herokuapp.com', provider: 'Heroku', kind: 'platform' },
  { suffix: 'web.app', provider: 'Firebase Hosting', kind: 'platform' },
  { suffix: 'firebaseapp.com', provider: 'Firebase Hosting', kind: 'platform' },
  { suffix: 'azurewebsites.net', provider: 'Azure App Service', kind: 'platform' },
  { suffix: 'cloudfunctions.net', provider: 'Google Cloud Functions', kind: 'platform' },
  { suffix: 'run.app', provider: 'Google Cloud Run', kind: 'platform' },
  { suffix: 'fly.dev', provider: 'Fly.io', kind: 'platform' },
  { suffix: 'render.com', provider: 'Render', kind: 'platform' },
  { suffix: 'onrender.com', provider: 'Render', kind: 'platform' },
  { suffix: 'replit.app', provider: 'Replit', kind: 'platform' },
  { suffix: 'repl.co', provider: 'Replit', kind: 'platform' },
  { suffix: 'glitch.me', provider: 'Glitch', kind: 'platform' },
  { suffix: 'surge.sh', provider: 'Surge', kind: 'platform' },
  { suffix: 'wordpress.com', provider: 'WordPress.com', kind: 'platform' },
  { suffix: 'blogspot.com', provider: 'Blogger', kind: 'platform' },
  { suffix: 'weebly.com', provider: 'Weebly', kind: 'platform' },
  { suffix: 'wixsite.com', provider: 'Wix', kind: 'platform' },
  { suffix: 'squarespace.com', provider: 'Squarespace', kind: 'platform' },
  { suffix: 'notion.site', provider: 'Notion', kind: 'platform' },
  { suffix: 'framer.website', provider: 'Framer', kind: 'platform' },
  { suffix: 'webflow.io', provider: 'Webflow', kind: 'platform' },
  { suffix: 'ngrok.io', provider: 'ngrok tunnel', kind: 'platform' },
  { suffix: 'ngrok-free.app', provider: 'ngrok tunnel', kind: 'free_subdomain' },
  {
    suffix: 'msdc.co',
    provider: 'Mailsac zero-setup subdomain',
    kind: 'free_subdomain',
    note: 'Mailsac issues these under its own suffix with no DNS work from the customer',
  },

  // Free subdomain and dynamic-DNS providers: free to obtain and therefore disposable by construction.
  // Registration economics for these come from this table rather than from the pricing collector, since
  // there is no registry price to look up.
  { suffix: 'us.kg', provider: 'free subdomain provider', kind: 'free_subdomain' },
  { suffix: 'eu.cc', provider: 'free subdomain provider', kind: 'free_subdomain' },
  { suffix: 'eu.org', provider: 'free subdomain provider', kind: 'free_subdomain' },
  { suffix: 'pp.ua', provider: 'free subdomain provider', kind: 'free_subdomain' },
  { suffix: 'dynu.net', provider: 'Dynu dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'ddns.net', provider: 'No-IP dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'no-ip.org', provider: 'No-IP dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'no-ip.biz', provider: 'No-IP dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'hopto.org', provider: 'No-IP dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'zapto.org', provider: 'No-IP dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'sytes.net', provider: 'No-IP dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'serveftp.com', provider: 'No-IP dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'duckdns.org', provider: 'DuckDNS', kind: 'free_subdomain' },
  { suffix: 'afraid.org', provider: 'FreeDNS', kind: 'free_subdomain' },
  { suffix: 'mooo.com', provider: 'FreeDNS', kind: 'free_subdomain' },
  { suffix: 'chickenkiller.com', provider: 'FreeDNS', kind: 'free_subdomain' },
  { suffix: 'strangled.net', provider: 'FreeDNS', kind: 'free_subdomain' },
  { suffix: 'crabdance.com', provider: 'FreeDNS', kind: 'free_subdomain' },
  { suffix: 'is-a-good.dev', provider: 'is-a.dev free subdomain', kind: 'free_subdomain' },
  { suffix: 'is-a.dev', provider: 'is-a.dev free subdomain', kind: 'free_subdomain' },
  { suffix: 'js.org', provider: 'JS.org free subdomain', kind: 'free_subdomain' },
  { suffix: 'kozow.com', provider: 'Dynu dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'loseyourip.com', provider: 'Dynu dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'freedns.org', provider: 'FreeDNS', kind: 'free_subdomain' },
  { suffix: 'serveminecraft.net', provider: 'dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'webredirect.org', provider: 'dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'gleeze.com', provider: 'Dynu dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'casacam.net', provider: 'Dynu dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'mypets.ws', provider: 'Dynu dynamic DNS', kind: 'free_subdomain' },
  { suffix: 'accesscam.org', provider: 'Dynu dynamic DNS', kind: 'free_subdomain' },
];

/**
 * Longest-suffix match, so `is-a-good.dev` wins over `is-a.dev` and a three-label suffix wins over a
 * two-label one.
 */
export function matchProviderSuffix(host: string): ProviderSuffix | null {
  const normalised = host.toLowerCase().replace(/\.$/, '');
  let best: ProviderSuffix | null = null;
  for (const entry of PROVIDER_SUFFIXES) {
    if (normalised === entry.suffix || normalised.endsWith(`.${entry.suffix}`)) {
      if (!best || entry.suffix.length > best.suffix.length) best = entry;
    }
  }
  return best;
}
