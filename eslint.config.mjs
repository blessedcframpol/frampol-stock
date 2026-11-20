// eslint-config-next 16.1.6 already exports ESLint 9 flat config arrays.
// FlatCompat cannot wrap those (Next 16 dropped the legacy eslintrc shape;
// compat.extends("next/core-web-vitals") hangs resolving them). Spreading the
// official entrypoints is the Next 16 equivalent of extends next/core-web-vitals
// and next/typescript.
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import reactHooks from "eslint-plugin-react-hooks"

const eslintConfig = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "supabase/migrations/**",
      "scripts/archive/**",
      "tmp/**",
      "exports/**",
      "docs/qa/**",
      ".dev-routes-stash/**",
    ],
  },
  {
    // Flat config: plugins must be declared on the same object as rule overrides.
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // TQ1: noisy across many files — warn instead of mass-editing.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/globals": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]

export default eslintConfig
