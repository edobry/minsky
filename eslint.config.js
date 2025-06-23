import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: [
      "codemods/**",
      "test-tmp/**",
      "test-analysis/**",
      "test-verification/**",
      "node_modules/**",
      "dist/**",
    ],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        process: "readonly",
        Buffer: "readonly",
        global: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        globalThis: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        atob: "readonly",
        btoa: "readonly",
        crypto: "readonly",
        performance: "readonly",
        structuredClone: "readonly",
        jest: "readonly",
        module: "readonly",
        exports: "readonly",
        require: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsEslint,
      import: importPlugin,
    },
    files: ["**/*.ts", "**/*.js"],
    rules: {
      // ===== CORE ESLINT RULES =====

      // Variables and scope
      "no-unused-vars": "off", // Handled by TypeScript rule
      "no-undef": "off", // TypeScript handles this
      "prefer-const": "error",
      "no-var": "error",

      // Code style and formatting
      indent: ["error", 2],
      "linebreak-style": ["error", "unix"],
      quotes: ["error", "double"],
      semi: ["error", "always"],
      "prefer-template": "error",

      // Error prevention
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",
      "no-useless-catch": "error",
      "no-useless-escape": "off",
      "no-unreachable": "error",
      "no-duplicate-imports": "error",
      "no-self-compare": "error",
      "consistent-return": "error",

      // Best practices
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-return-await": "error",
      "require-await": "error",

      // Console usage
      "no-console": "error",

      // ===== TYPESCRIPT-ESLINT RULES =====

      // Type safety
      "@typescript-eslint/no-explicit-any": "error", // Stricter than before
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",

      // Function and method best practices
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/no-non-null-assertion": "warn",

      // Variable and parameter handling
      "@typescript-eslint/no-unused-vars": [
        "error", // Changed from "warn" to "error"
        {
          argsIgnorePattern: "^_+",
          varsIgnorePattern: "^_+",
          ignoreRestSiblings: true,
        },
      ],

      // Type definitions and usage
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          disallowTypeAnnotations: false,
        },
      ],

      // Promise handling
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // ===== IMPORT PLUGIN RULES =====

      // Import organization
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "never",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],
      "import/no-duplicates": "error",
      "import/no-unused-modules": "warn",
      "import/first": "error",
      "import/newline-after-import": "error",

      // ===== MAGIC NUMBERS =====
      "no-magic-numbers": [
        "warn",
        {
          ignore: [0, 1, -1, 2, 10, 100, 1000],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
          enforceConst: true,
        },
      ],
    },
  },
  {
    // Logger exception for console usage
    files: ["src/utils/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Test file exceptions
    files: ["**/test/**", "**/*.test.ts", "**/__tests__/**", "**/__fixtures__/**"],
    rules: {
      "no-console": "warn", // Allow console in tests but warn
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "no-magic-numbers": "off", // Tests often use magic numbers
      "@typescript-eslint/no-floating-promises": "off", // Tests might not await all promises
      "consistent-return": "off", // Test functions don't need consistent returns
    },
  },
  {
    // CLI entry point exceptions
    files: ["src/cli.ts"],
    rules: {
      "no-console": "off", // CLI needs console output
      "@typescript-eslint/no-floating-promises": "off", // CLI might not await top-level promises
    },
  },
];
