import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

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
