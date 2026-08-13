# Accessibility

Target is WCAG 2.2 AA. The theme is dark-only and stays that way; a light theme is a design decision
rather than a conformance one, and nothing here depends on having both.

Most of this document is the reasoning behind things that were **not** changed. The changes speak for
themselves in the diff; the non-changes are what someone will otherwise re-litigate.

## Contrast

Ratios are WCAG 2.1 relative luminance against each of the three surface tokens, in the order
`surface` / `surface-raised` / `surface-sunken`. Every figure is asserted by `test/contrast.test.ts`,
which parses these values out of the `@theme` block in `app/globals.css` rather than repeating them,
so a token edited to a failing value fails the suite.

| Token         | Value     | surface | raised | sunken | Floor  |
| ------------- | --------- | ------- | ------ | ------ | ------ |
| `ink`         | `#e8edf4` | 16.34   | 15.16  | 16.76  | 4.5    |
| `ink-muted`   | `#94a3b3` | 7.46    | 6.92   | 7.65   | 4.5    |
| `ink-faint`   | `#7d8b9d` | 5.54    | 5.14   | 5.68   | 4.5    |
| `edge`        | `#1e2733` | 1.28    | 1.18   | 1.31   | — |
| `edge-strong` | `#5a6b7e` | 3.51    | 3.26   | 3.60   | 3.0    |
| `danger`      | `#f87171` | 6.95    | 6.45   | 7.13   | 4.5    |
| `caution`     | `#fb923c` | 8.49    | 7.88   | 8.71   | 4.5    |
| `warn`        | `#fbbf24` | 11.51   | 10.69  | 11.81  | 4.5    |
| `probable`    | `#a3e635` | 12.75   | 11.83  | 13.08  | 4.5    |
| `accent`      | `#4ade80` | 11.03   | 10.24  | 11.31  | 4.5    |

Composited values, since a translucent colour is not what the eye receives:

| Where                            | Effective | Floor |
| -------------------------------- | --------- | ----- |
| `accent/70` positive bar, raised | 5.60      | 3.0   |
| `danger/70` negative bar, raised | 3.73      | 3.0   |
| `accent/50` focused input, sunken | 3.50     | 3.0   |

### Why `edge` was split rather than raised

`--color-edge` sits at 1.28:1 and is used in two structurally different ways: as a divider or card
outline, and as the border that tells a reader where the domain input is. Only the second is a control
boundary, and 1.4.11 applies only to boundaries needed to identify a component — a decorative separator
is exempt.

Raising `edge` itself to 3:1 would have lightened every divider and card in the app to fix two
elements, which is a visible redesign in service of a rule that does not ask for it. Adding
`--color-edge-strong` and applying it at the four places that are genuinely control boundaries — the
domain input, the example chips, the Cancel button, the skip link — costs nothing anywhere else.

`test/contrast.test.ts` asserts `edge` is *below* 3:1 as well as asserting `edge-strong` is above it.
That reads backwards until you see the intent: it makes using `edge` on a control a decision somebody
has to come here and change, rather than one that slips through because both tokens looked
interchangeable.

### The compressed ink hierarchy

Raising `ink-faint` from `#64748b` to `#7d8b9d` took the three-step ink scale from 16.3 / 7.5 / 4.0 to
16.3 / 7.5 / 5.5. The gap between `muted` and `faint` is now narrower than it was. If they ever read as
the same colour, the fix is to lighten `ink-muted`, not to darken `ink-faint` back below the floor.

## Deliberate non-changes

- **Per-source progress is not announced.** Eight sources settle per analysis, and announcing each
  would fire eight times. The start of an analysis and its terminal state go through the polite live
  region; failures interrupt with `role="alert"`. That is the right amount of speech for one query.
- **The `ring-*/30` verdict pill rings stay at 2.02:1.** The ring is decoration drawn around text that
  already carries the verdict in words and in colour. Nothing is conveyed by the ring alone.
- **`--color-edge` stays at 1.28:1 for dividers and card borders.** See above.
- **No tooltips, anywhere.** Recorded in `components/DimensionBars.tsx` and still true: a `title`
  attribute survives neither touch nor a keyboard, so an explanation that only exists in one is an
  explanation some readers do not have. Jargon is handled by the glossary disclosure in
  `components/SignalRows.tsx` instead, which is a real control that a reader can reach either way.
- **Contrast is excluded from the axe run.** Not an oversight. Under jsdom there is no layout, so axe's
  `color-contrast` rule has nothing to sample and reports nothing — which is worse than not running it,
  because the suite would appear to have checked. `test/contrast.test.ts` does it arithmetically.
- **The `region` rule is excluded from the axe run.** The tests render the page component, not the
  layout that provides the landmarks, so the rule would fire on the absence of markup the render never
  included.

## Guardrails

Three, because none of this stays true on its own.

- `eslint.config.mjs` runs the full `jsx-a11y` strict set, 31 rules, rather than the six that
  `next/core-web-vitals` bundles. The package is an explicit devDependency so a Next upgrade cannot
  quietly change which rules run.
- `test/contrast.test.ts` checks the palette against its floors, reading the values out of the
  stylesheet.
- `test/a11y.test.tsx` runs `axe-core` over the rendered page in each state a reader can reach: empty,
  pending, a full result, every disclosure expanded, out of scope, a service error, a network failure,
  and an input rejected in the browser. It renders the whole page rather than isolated components,
  because most of what axe checks is relational — whether a label is associated with its input,
  whether `aria-controls` names something that exists, whether generated ids stay unique once every
  panel is open at once. A component checked alone satisfies all of those vacuously.

## Known gaps

- Contrast is only ever checked at the token level. A one-off colour written inline in a component
  would not be caught by either test. There are none today.
- `prefers-reduced-motion` is handled by a blanket rule in `app/globals.css` and is not tested. The
  rule is three lines and applies to `*`, so there is not much surface for it to be wrong on, but
  nothing enforces that it stays.
- No testing with an actual screen reader. The live regions, the `role="alert"` banners and the
  disclosure semantics are correct by construction and by axe, which is not the same as verified.
