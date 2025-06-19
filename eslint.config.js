import js from "@eslint/js";
import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

export default [
  js.configs.recommended,
  {
    ignores: [
      // Exclude codemod scripts from linting
      "codemods/**",
      // Exclude other development/temporary files
      "test-tmp/**",
      "test-analysis/**",
      "test-verification/**",
    ],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        process: "readonly",
        Buffer: "readonly",
        global: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        globalThis: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsEslint,
      import: importPlugin,
    },
    files: ["**/*.ts", "**/*.js"],
    rules: {
      indent: ["error", 2],
      "linebreak-style": ["error", "unix"],
      quotes: ["error", "double"],
      semi: ["error", "always"],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-magic-numbers": [
        "warn",
        { ignore: [0, 1, -1], ignoreArrayIndexes: true, enforceConst: true },
      ],
      "prefer-template": "error",
      "no-var": "error",
      "prefer-const": "off",
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",
      "no-useless-catch": "error",
      "no-console": "error",
      "max-lines": "off",
      "no-restricted-globals": "off",
      "import/extensions": "off",
      "import/no-unresolved": ["off", { ignore: [".ts"] }],
      "no-useless-escape": "off",
      "@typescript-eslint/ban-types": "off",
    },
  },
  {
    files: ["src/utils/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/test/**", "**/*.test.ts", "**/__tests__/**"],
    rules: {
      "no-console": "warn",
    },
  },
];
