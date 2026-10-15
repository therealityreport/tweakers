import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "packages/installer/assets/**"] },
  { files: ["tweaks/**/*.{js,cjs,mjs}", "scripts/**/*.mjs"], rules: { "no-debugger": "error", "no-duplicate-case": "error", "no-unreachable": "error" } },
  {
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      eqeqeq: ["warn", "always"],
      "no-debugger": "error",
      "no-duplicate-case": "error",
      "no-empty": ["warn", { allowEmptyCatch: false }],
      "no-unreachable": "error",
      "no-var": "error",
      "prefer-const": "warn",
      "@typescript-eslint/no-empty-function": "warn",
    },
  },
];
