import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import jsxA11y from "eslint-plugin-jsx-a11y";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    /*
     * The full accessibility rule set, not the six rules `next/core-web-vitals` bundles.
     *
     * Only the `rules` are taken. The flat config also carries a `plugins` key, and `next/core-web-vitals`
     * has already registered `jsx-a11y` under that same name, which flat config refuses to let anything
     * redefine. Depending on the package explicitly is still worth doing: it pins which rule set is being
     * asked for, so upgrading Next cannot quietly change the answer.
     */
    files: ["**/*.{jsx,tsx}"],
    rules: jsxA11y.flatConfigs.strict.rules,
  },
  {
    // Tailwind v3 accepted `text-[--color-ink]` as shorthand for a custom property. Tailwind v4 does
    // not, and it fails by emitting no rule at all rather than by erroring, so a whole palette can stop
    // applying without anything going red. Every colour in `@theme` already has a named utility.
    files: ["**/*.{ts,tsx,js,jsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/\\[--[a-z]/]",
          message:
            "Tailwind v4 does not support the `[--custom-property]` class shorthand and silently emits nothing. Use the named utility from @theme (`text-ink-muted`) or `text-(--color-ink-muted)`.",
        },
        {
          selector: "TemplateElement[value.raw=/\\[--[a-z]/]",
          message:
            "Tailwind v4 does not support the `[--custom-property]` class shorthand and silently emits nothing. Use the named utility from @theme (`text-ink-muted`) or `text-(--color-ink-muted)`.",
        },
      ],
    },
  },
];

export default eslintConfig;
