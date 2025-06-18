import js from "@eslint/js";
import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

export default [
  js.configs.recommended,
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
        // Node.js globals
        process: "readonly",
        Buffer: "readonly",
        global: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        // ES2021 globals
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
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "./*/domain/!(*index)",
                "../*/domain/!(*index)",
                "./*/domain/!(*index).js",
                "../*/domain/!(*index).js",
              ],
              message:
                "Import domain modules from their index file (extensionless) instead of directly or with .js extension",
            },
            {
              group: ["./commands/*", "../commands/*"],
              message:
                "Command modules should not be imported by other modules; use domain modules instead",
            },
            {
              group: ["./*.ts", "../*.ts", "./*.js", "../*.js"],
              message: "Use extensionless imports for local files (Bun-native style)",
            },
            {
              group: ["**/cli-bridge", "**/cli-bridge.js", "**/cli-bridge.ts"],
              message:
                "Use CLI Command Factory instead of direct CLI bridge access. Import from cli-command-factory.ts instead.",
            },
          ],
        },
      ],
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
      "no-restricted-properties": [
        "error",
        {
          object: "console",
          property: "log",
          message:
            "Use log.cli() for user-facing output, log.agent() for structured data, or log.debug() for debugging information instead.",
        },
        {
          object: "console",
          property: "error",
          message:
            "Use log.error() for internal error logging or log.cliError() for user-facing errors instead.",
        },
        {
          object: "console",
          property: "warn",
          message:
            "Use log.warn() for internal warning logging or log.cliWarn() for user-facing warnings instead.",
        },
        {
          object: "console",
          property: "info",
          message: "Use log.info() or log.cli() for informational messages instead.",
        },
        {
          object: "console",
          property: "debug",
          message: "Use log.debug() for debug messages instead.",
        },
      ],
      "max-lines": "off",
      "no-restricted-globals": "off",
      "import/extensions": "off",
      "import/no-unresolved": ["off", { ignore: [".ts"] }],
      "no-useless-escape": "off",
      "@typescript-eslint/ban-types": "off",
    },
  },
  {
    files: ["**/domain/index.js", "**/domain/index.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["src/utils/logger.ts"],
    rules: {
      "no-console": "off",
      "no-restricted-properties": "off",
    },
  },
  {
    files: ["**/test/**", "**/*.test.ts", "**/__tests__/**"],
    rules: {
      "no-console": "warn",
      "no-restricted-properties": "warn",
    },
  },
];
