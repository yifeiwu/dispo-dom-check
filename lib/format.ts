/**
 * Display formatting shared by the pages and the components that render a score.
 *
 * This held an age formatter and a date formatter as well, both written for the result card's
 * registration row. That row was removed when the card was reduced to the gauge and the narrative,
 * and the two functions outlived their only caller — which is how `formatDate` ended up duplicating
 * the private one in `lib/bimi-vmc.ts` while being called by nothing. They are in the history if the
 * row comes back; keeping them here only made this module look like it was still preventing a
 * duplication it had become half of.
 */

/**
 * A score contribution with its sign always shown.
 *
 * The plus matters. These are rendered in columns beside penalties, and a bare `3` next to a `-8`
 * reads as a magnitude rather than as a direction. It was written three times before it lived here.
 */
export function signedPoints(points: number): string {
  return `${points > 0 ? '+' : ''}${points}`;
}
