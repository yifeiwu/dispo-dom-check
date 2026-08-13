import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The palette, checked against the contrast ratios it has to meet.
 *
 * This exists because the one thing axe cannot tell us is the thing most likely to break. Its
 * `color-contrast` rule needs a rendered page to sample, and under jsdom there is no layout and
 * nothing to sample, so it silently reports nothing rather than failing. A palette regression would
 * pass every other check in the repo.
 *
 * Read out of `globals.css` rather than duplicated here, so the numbers cannot pass while the
 * stylesheet says something else. Editing a token to a failing value fails the suite, which is the same
 * bargain the Tailwind v4 lint rule already makes: guard the footgun with a rule rather than with
 * review.
 */
const CSS = readFileSync(path.join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8');

/** Pulls `--color-*` declarations out of the `@theme` block. */
function tokens(css: string): Record<string, string> {
  const theme = /@theme[^{]*\{([\s\S]*?)\n\}/.exec(css);
  if (!theme) throw new Error('No @theme block found in globals.css');

  const found: Record<string, string> = {};
  for (const [, name, value] of theme[1].matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    found[name] = value.toLowerCase();
  }
  return found;
}

const COLOURS = tokens(CSS);

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(foreground: string, background: string): number {
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Flattens a Tailwind opacity modifier such as `accent/70` against what sits behind it.
 *
 * Contrast is a property of what a reader's eye receives, so a translucent bar has to be measured
 * composited rather than at its declared value. Nothing here draws over another translucent layer,
 * which is the case this deliberately does not handle.
 */
function over(foreground: string, background: string, alpha: number): string {
  const mix = [1, 3, 5].map((at) => {
    const f = parseInt(foreground.slice(at, at + 2), 16);
    const b = parseInt(background.slice(at, at + 2), 16);
    return Math.round(f * alpha + b * (1 - alpha));
  });
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const colour = (name: string): string => {
  const value = COLOURS[name];
  if (!value) throw new Error(`globals.css declares no --color-${name}`);
  return value;
};

const SURFACES = ['surface', 'surface-raised', 'surface-sunken'] as const;

/**
 * 4.5:1 is the WCAG AA floor for body text. Everything here is drawn below the 18.66px that would let
 * it qualify as large text, so none of it gets the 3:1 allowance.
 */
const TEXT_MINIMUM = 4.5;
/** 1.4.11, which covers a control's boundary and the meaningful parts of a graphic. */
const NON_TEXT_MINIMUM = 3;

describe('palette contrast', () => {
  /*
   * Every ink drawn on every surface. Listed as a cross-product rather than as the pairs that happen to
   * exist today, because the failure this guards against is someone using an existing colour somewhere
   * new, which a list of today's pairings would not notice.
   */
  describe.each(['ink', 'ink-muted', 'ink-faint'])('%s as body text', (ink) => {
    it.each(SURFACES)(`meets ${TEXT_MINIMUM}:1 on %s`, (surface) => {
      expect(ratio(colour(ink), colour(surface))).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    });
  });

  /* The verdict colours, each of which is drawn as text somewhere: a score, a pill, a status, a total. */
  describe.each(['danger', 'caution', 'warn', 'probable', 'accent'])('%s as verdict text', (band) => {
    it.each(SURFACES)(`meets ${TEXT_MINIMUM}:1 on %s`, (surface) => {
      expect(ratio(colour(band), colour(surface))).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    });
  });

  it('draws control boundaries in edge-strong, which clears the non-text floor', () => {
    for (const surface of SURFACES) {
      expect(ratio(colour('edge-strong'), colour(surface))).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
    }
  });

  /*
   * `edge` is deliberately below that floor and must stay a decoration. 1.4.11 exempts a boundary that
   * is not needed to identify a control, which is what every divider and card outline in this app is.
   * Asserted rather than assumed, so that using it on a control is a decision somebody has to make here
   * rather than one that slips through.
   */
  it('keeps edge below the control floor, marking it decorative', () => {
    expect(ratio(colour('edge'), colour('surface'))).toBeLessThan(NON_TEXT_MINIMUM);
  });

  /*
   * The dimension bars, which are graphics rather than text and carry the 3:1 floor. They are drawn at
   * 70% over the raised surface, so the declared colour is not what a reader sees.
   */
  it.each([
    ['accent', 'a positive dimension bar'],
    ['danger', 'a negative dimension bar'],
  ])('composites %s at 70%% above the non-text floor (%s)', (band) => {
    const raised = colour('surface-raised');
    expect(ratio(over(colour(band), raised, 0.7), raised)).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
  });

  /* The focus border on the domain input, drawn at 50% over the sunken field background. */
  it('composites the focused input border above the non-text floor', () => {
    const sunken = colour('surface-sunken');
    expect(ratio(over(colour('accent'), sunken, 0.5), sunken)).toBeGreaterThanOrEqual(
      NON_TEXT_MINIMUM,
    );
  });

  /*
   * The focus ring every control shares, which is the one piece of non-text contrast a keyboard reader
   * cannot do without.
   */
  it('draws the focus ring well clear of the non-text floor', () => {
    for (const surface of SURFACES) {
      expect(ratio(colour('accent'), colour(surface))).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
    }
  });

  it('parsed the palette rather than silently finding nothing', () => {
    expect(Object.keys(COLOURS).length).toBeGreaterThanOrEqual(12);
  });
});
