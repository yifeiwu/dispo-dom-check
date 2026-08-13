/**
 * Display formatting shared by the pages and the components that render a score.
 *
 * Small functions, kept together because each was written twice: the sign on a score contribution in
 * three places and the date in two. None of them is hard, which is exactly why the copies diverged
 * without anyone noticing — a table showing `3` beside a list showing `+3` for the same heuristic is
 * the kind of difference a reader reads as meaningful.
 */

/**
 * A score contribution with its sign always shown.
 *
 * The plus matters. These are rendered in columns beside penalties, and a bare `3` next to a `-8`
 * reads as a magnitude rather than as a direction.
 */
export function signedPoints(points: number): string {
  return `${points > 0 ? '+' : ''}${points}`;
}

/**
 * An age in the largest unit that still says something useful.
 *
 * Days below two months, because the difference between 3 and 40 days is the whole signal at that end
 * of the range; years above two, because nobody reads "4,238 days" as a duration.
 */
export function formatAge(days: number): string {
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 730) {
    const months = Math.round(days / 30.44);
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  const years = Math.round((days / 365.25) * 10) / 10;
  return `${years} year${years === 1 ? '' : 's'}`;
}

/**
 * A registration date, in UTC.
 *
 * Fixed to UTC rather than the reader's zone because a registry publishes one instant and the date it
 * falls on should not depend on who is looking: a creation timestamp late on the 1st in UTC would
 * otherwise render as the 2nd for half the world, and the age arithmetic beside it would disagree.
 */
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}
