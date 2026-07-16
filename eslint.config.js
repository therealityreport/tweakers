import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
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
