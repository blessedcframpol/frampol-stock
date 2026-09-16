// eslint-config-next 16.1.6 already exports ESLint 9 flat config arrays.
// FlatCompat cannot wrap those (Next 16 dropped the legacy eslintrc shape;
// compat.extends("next/core-web-vitals") hangs resolving them). Spreading the
// official entrypoints is the Next 16 equivalent of extends next/core-web-vitals
// and next/typescript.
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

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
    ],
  },
]

export default eslintConfig
