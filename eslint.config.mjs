import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
  },
  globalIgnores([
    ".next/**",
    ".local/**",
    "node_modules/**",
    ".npm-cache/**",
    "next-env.d.ts",
  ]),
]);
