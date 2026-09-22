import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "tests/.build/**", ".next/**", "scripts/tests/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Runtime globals across Deno (edge fn) and Node (routes/tests)
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        Deno: "readonly", crypto: "readonly", fetch: "readonly",
        Request: "readonly", Response: "readonly", URL: "readonly",
        AbortSignal: "readonly", TextEncoder: "readonly", Intl: "readonly",
        console: "readonly", process: "readonly", Buffer: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
  {
    // test scripts (node)
    files: ["tests/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
