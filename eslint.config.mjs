import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-browser-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "apps/customer/android/**", "apps/customer/ios/**", "apps/customer/.expo/**", "apps/customer/dist/**", "apps/customer/build/**",
  ]),
]);

export default eslintConfig;
