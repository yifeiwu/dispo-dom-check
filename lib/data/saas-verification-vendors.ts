/**
 * Vendor fingerprints for apex TXT verification records.
 *
 * Counting *distinct vendors* is a strong proxy for real organisational spend, because each record is
 * the residue of someone completing a domain-verification step inside a paid product. A large
 * organisation accumulates dozens of these across identity, payment, collaboration and security
 * vendors; an account-farm domain has zero or one.
 *
 * The dimension is positive-only. A legitimate small business having none of these is the normal case,
 * not evidence of anything, which is why absence feeds the correlated-absence discount instead of a
 * penalty.
 */
export const SAAS_VERIFICATION_VENDORS: readonly { prefix: string; vendor: string }[] = [
  { prefix: 'google-site-verification=', vendor: 'Google' },
  { prefix: 'ms=', vendor: 'Microsoft' },
  { prefix: 'ms-ms', vendor: 'Microsoft' },
  { prefix: 'msvalidate.01=', vendor: 'Microsoft Bing' },
  { prefix: 'apple-domain-verification=', vendor: 'Apple' },
  { prefix: 'apple-domain=', vendor: 'Apple' },
  { prefix: 'facebook-domain-verification=', vendor: 'Meta' },
  { prefix: 'stripe-verification=', vendor: 'Stripe' },
  { prefix: 'atlassian-domain-verification=', vendor: 'Atlassian' },
  { prefix: 'docusign=', vendor: 'DocuSign' },
  { prefix: 'adobe-idp-site-verification=', vendor: 'Adobe' },
  { prefix: 'adobe-sign-verification=', vendor: 'Adobe' },
  { prefix: 'slack-domain-verification=', vendor: 'Slack' },
  { prefix: 'zoom-domain-verification=', vendor: 'Zoom' },
  { prefix: 'dropbox-domain-verification=', vendor: 'Dropbox' },
  { prefix: 'box-domain-verification=', vendor: 'Box' },
  { prefix: 'hubspot-developer-verification=', vendor: 'HubSpot' },
  { prefix: 'mongodb-site-verification=', vendor: 'MongoDB' },
  { prefix: 'onepassword-site-verification=', vendor: '1Password' },
  { prefix: 'bugcrowd-verification=', vendor: 'Bugcrowd' },
  { prefix: 'detectify-verification=', vendor: 'Detectify' },
  { prefix: 'openai-domain-verification=', vendor: 'OpenAI' },
  { prefix: 'anthropic-domain-verification=', vendor: 'Anthropic' },
  { prefix: 'notion-domain-verification=', vendor: 'Notion' },
  { prefix: 'figma-domain-verification=', vendor: 'Figma' },
  { prefix: 'asana-domain-verification=', vendor: 'Asana' },
  { prefix: 'miro-domain-verification=', vendor: 'Miro' },
  { prefix: 'canva-domain-verification=', vendor: 'Canva' },
  { prefix: 'zendesk-verification=', vendor: 'Zendesk' },
  { prefix: 'intercom-domain-verification', vendor: 'Intercom' },
  { prefix: 'freshdesk-domain-verification', vendor: 'Freshdesk' },
  { prefix: 'shopify-verification', vendor: 'Shopify' },
  { prefix: 'wix-domain-verification', vendor: 'Wix' },
  { prefix: 'webflow-verification', vendor: 'Webflow' },
  { prefix: 'squarespace-domain-verification', vendor: 'Squarespace' },
  { prefix: 'cloudflare-verify', vendor: 'Cloudflare' },
  { prefix: 'amazonses:', vendor: 'Amazon SES' },
  { prefix: 'sendgrid-verification', vendor: 'SendGrid' },
  { prefix: 'mailgun-verification', vendor: 'Mailgun' },
  { prefix: 'postman-domain-verification', vendor: 'Postman' },
  { prefix: 'segment-site-verification', vendor: 'Segment' },
  { prefix: 'twilio-domain-verification', vendor: 'Twilio' },
  { prefix: 'workplace-domain-verification', vendor: 'Meta Workplace' },
  { prefix: 'logmein-verification', vendor: 'LogMeIn' },
  { prefix: 'citrix-verification', vendor: 'Citrix' },
  { prefix: 'yandex-verification', vendor: 'Yandex' },
  { prefix: 'pinterest-site-verification', vendor: 'Pinterest' },
  { prefix: 'tiktok-developers-site-verification', vendor: 'TikTok' },
  { prefix: 'loom-site-verification', vendor: 'Loom' },
  { prefix: 'calendly-site-verification', vendor: 'Calendly' },
  { prefix: 'okta-verification', vendor: 'Okta' },
  { prefix: 'onelogin-verification', vendor: 'OneLogin' },
  { prefix: 'duo-verification', vendor: 'Duo' },
  { prefix: 'knowbe4-site-verification', vendor: 'KnowBe4' },
  { prefix: 'have-i-been-pwned-verification', vendor: 'HIBP' },
  { prefix: 'status-page-domain-verification', vendor: 'Statuspage' },
  { prefix: 'atlassian-sending-domain-verification', vendor: 'Atlassian' },
  { prefix: 'brevo-code', vendor: 'Brevo' },
  { prefix: 'mailchimp-domain-verification', vendor: 'Mailchimp' },
  { prefix: 'klaviyo-site-verification', vendor: 'Klaviyo' },
  { prefix: 'drift-domain-verification', vendor: 'Drift' },
  { prefix: 'smartsheet-site-validation', vendor: 'Smartsheet' },
  { prefix: 'workiva-site-verification', vendor: 'Workiva' },
  { prefix: 'dynatrace-site-verification', vendor: 'Dynatrace' },
  { prefix: 'datadog-site-verification', vendor: 'Datadog' },
  { prefix: 'sophos-domain-verification', vendor: 'Sophos' },
  { prefix: 'globalsign-domain-verification', vendor: 'GlobalSign' },
  { prefix: 'digicert-domain-verification', vendor: 'DigiCert' },
  { prefix: 'ca3-', vendor: 'DigiCert' },
  { prefix: 'teamviewer-sso-verification', vendor: 'TeamViewer' },
];

/** Counts distinct vendors across the apex TXT set. */
export function countSaasVendors(txtRecords: readonly string[]): string[] {
  const found = new Set<string>();
  for (const raw of txtRecords) {
    const record = raw.toLowerCase().replace(/^"|"$/g, '');
    for (const { prefix, vendor } of SAAS_VERIFICATION_VENDORS) {
      if (record.startsWith(prefix.toLowerCase())) {
        found.add(vendor);
        break;
      }
    }
  }
  return [...found].sort();
}

/**
 * DMARC `rua` destinations belonging to commercial reporting vendors. Paying a vendor to process
 * aggregate reports is evidence of a real mail programme. Sophisticated operators frequently self-host
 * reporting instead, so this is a positive where present and never a negative where absent.
 */
export const COMMERCIAL_DMARC_VENDORS: readonly string[] = [
  'agari.com',
  'vali.email',
  'dmarcian.com',
  'valimail.com',
  'proofpoint.com',
  'easydmarc.com',
  'dmarcadvisor.com',
  'ondmarc.redsift.com',
  'redsift.com',
  'mxtoolbox.com',
  'postmarkapp.com',
  'fraudmarc.com',
  'sendmarc.com',
  'powerdmarc.com',
  'dmarcanalyzer.com',
  'skysnag.com',
  'urivalidation.com',
  'emaildefence.com',
  'reports.dmarctools.com',
  'rua.dmarcaware.com',
];

/**
 * SPF include targets that name a paid sending product. Someone pays per message for these, so they
 * indicate commercial activity rather than a domain that only receives.
 */
export const PAID_SPF_SENDERS: readonly { pattern: string; vendor: string }[] = [
  { pattern: 'salesforce.com', vendor: 'Salesforce' },
  { pattern: 'sendgrid.net', vendor: 'SendGrid' },
  { pattern: 'mailgun.org', vendor: 'Mailgun' },
  { pattern: 'mktomail.com', vendor: 'Marketo' },
  { pattern: 'hubspot.com', vendor: 'HubSpot' },
  { pattern: 'hubspotemail.net', vendor: 'HubSpot' },
  { pattern: 'zendesk.com', vendor: 'Zendesk' },
  { pattern: 'freshemail.io', vendor: 'Freshworks' },
  { pattern: 'intercom.io', vendor: 'Intercom' },
  { pattern: 'klaviyomail.com', vendor: 'Klaviyo' },
  { pattern: 'mcsv.net', vendor: 'Mailchimp' },
  { pattern: 'servers.mcsv.net', vendor: 'Mailchimp' },
  { pattern: 'sparkpostmail.com', vendor: 'SparkPost' },
  { pattern: 'mandrillapp.com', vendor: 'Mandrill' },
  { pattern: 'postmarkapp.com', vendor: 'Postmark' },
  { pattern: 'amazonses.com', vendor: 'Amazon SES' },
  { pattern: 'stripe.com', vendor: 'Stripe' },
  { pattern: 'atlassian.net', vendor: 'Atlassian' },
  { pattern: 'zuora.com', vendor: 'Zuora' },
  { pattern: 'netsuite.com', vendor: 'NetSuite' },
  { pattern: 'docusign.net', vendor: 'DocuSign' },
  { pattern: 'workday.com', vendor: 'Workday' },
  { pattern: 'successfactors.com', vendor: 'SAP SuccessFactors' },
  { pattern: 'qualtrics.com', vendor: 'Qualtrics' },
  { pattern: 'surveymonkey.com', vendor: 'SurveyMonkey' },
  { pattern: 'ringcentral.com', vendor: 'RingCentral' },
  { pattern: 'talkdesk.com', vendor: 'Talkdesk' },
  { pattern: 'brevo.com', vendor: 'Brevo' },
  { pattern: 'sendinblue.com', vendor: 'Brevo' },
  { pattern: 'constantcontact.com', vendor: 'Constant Contact' },
  { pattern: 'icontact.com', vendor: 'iContact' },
  { pattern: 'exacttarget.com', vendor: 'Salesforce Marketing Cloud' },
  { pattern: 'et.exacttarget.com', vendor: 'Salesforce Marketing Cloud' },
  { pattern: 'pardot.com', vendor: 'Pardot' },
  { pattern: 'zoho.com', vendor: 'Zoho' },
];
