/**
 * Plain-language definitions for the acronyms a verdict cannot avoid using.
 *
 * The signal labels are already written in English — "Mail handled by a throwaway-inbox service" — but
 * the evidence beneath them names the records it read, and those are unavoidably SPF, DMARC, MX and the
 * rest. A reader who does not administer DNS can follow the verdict and not the reason for it, which is
 * the half of this tool that matters.
 *
 * Definitions rather than tooltips, for the reason already recorded in `components/DimensionBars.tsx`:
 * a `title` attribute survives neither touch nor a keyboard. They are collected into one disclosure
 * that lists only the terms a particular result actually used, so the glossary is as short as that
 * domain made it and a reader who needs none of it sees one line.
 */
export type GlossaryEntry = {
  /** The term as a reader will meet it on the page. */
  term: string;
  definition: string;
  /**
   * Extra spellings that mean the same term, so "mail exchanger" finds the MX entry. Matched
   * case-insensitively on a word boundary, which is why bare acronyms need no variants.
   */
  aliases?: string[];
};

export const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'MX',
    definition:
      'The DNS record naming the server that receives a domain\u2019s mail. No MX record means no inbound mail, and whose server it names is the strongest single clue about what the domain is for.',
    aliases: ['mail exchanger', 'mail exchangers'],
  },
  {
    term: 'SPF',
    definition:
      'A record listing which servers may send mail claiming to be from the domain. It says nothing about who may receive it, and a domain can publish one in seconds, so it is read here as a statement of intent rather than as evidence of legitimacy.',
  },
  {
    term: 'DKIM',
    definition:
      'A public key published in DNS that lets a recipient verify outgoing mail was signed by the domain. Like SPF, it is written by whoever controls the zone and confirmed by nobody.',
  },
  {
    term: 'DMARC',
    definition:
      'A policy saying what a recipient should do with mail that fails SPF and DKIM checks. A strict policy signals a domain that cares about its own name being forged, but costs nothing to publish.',
  },
  {
    term: 'DNSSEC',
    definition:
      'Cryptographic signing of a domain\u2019s DNS records, which stops an attacker forging answers about it. Measured here and deliberately not scored, because it turned out to describe which registrar was used rather than who was using it.',
  },
  {
    term: 'RDAP',
    definition:
      'The modern protocol for looking up who registered a domain and when. It is the successor to WHOIS and returns the same facts as structured data.',
  },
  {
    term: 'WHOIS',
    definition:
      'The older registration-lookup protocol, still the only option at registries that publish no RDAP service. Queried over port 43, which is why its source is shown as a whois:// address that a browser cannot follow.',
  },
  {
    term: 'TLD',
    definition:
      'The last part of a domain name, such as .com or .sbs. Registries price them very differently, and a first-year price near zero is what makes disposable registration at volume affordable.',
    aliases: ['top-level domain', 'suffix'],
  },
  {
    term: 'Catch-all',
    definition:
      'A mail configuration accepting mail for every address at the domain, including ones nobody created. One registration then yields an unlimited supply of deliverable addresses, which is precisely the capability this model is looking for.',
    aliases: ['catch all', 'wildcard'],
  },
  {
    term: 'Nameserver',
    definition:
      'The server answering DNS questions about a domain. Leaving the registrar\u2019s default nameservers in place says the zone was never configured for anything in particular.',
    aliases: ['nameservers', 'NS record'],
  },
  {
    term: 'Parked',
    definition:
      'A domain resolving to a placeholder page rather than a site, usually advertising or a for-sale notice. It marks a registration nobody has built anything on.',
  },
  {
    term: 'Registrar',
    definition:
      'The company a domain was bought through, as distinct from the registry that operates the suffix itself.',
  },
];

/** A word-boundary matcher, so "MX" does not match "Linux" and "suffix" does not match "suffixes". */
function mentions(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

/**
 * The subset of the glossary a particular result actually used.
 *
 * Scanning the rendered strings rather than tagging each signal with its terms keeps the two from
 * drifting: a reworded piece of evidence brings its own terms with it, and a signal that stops
 * mentioning DMARC stops explaining it. Returned in `GLOSSARY` order so the list does not reshuffle
 * itself between two domains a reader is comparing.
 */
export function glossaryFor(text: string[]): GlossaryEntry[] {
  const corpus = text.join('\n');
  return GLOSSARY.filter((entry) =>
    [entry.term, ...(entry.aliases ?? [])].some((form) => mentions(corpus, form)),
  );
}
