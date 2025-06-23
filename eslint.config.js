import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["codemods/**", "test-tmp/**", "test-analysis/**", "test-verification/**"],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
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
    },
    files: ["**/*.ts", "**/*.js"],
    rules: {
      // Core ESLint rules
      "no-unused-vars": "off", // EXPLICITLY DISABLED
      "no-undef": "off",
      indent: ["error", 2],
      "linebreak-style": ["error", "unix"],
      quotes: ["error", "double"],
      semi: ["error", "always"],
      "prefer-template": "error",
      "no-var": "error",
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",
      "no-useless-catch": "error",
      "no-console": "error",
      "no-useless-escape": "off",

      // TypeScript rules
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_+",
          varsIgnorePattern: "^_+",
        },
      ],
      "@typescript-eslint/ban-types": "off",

      // Magic numbers
      "no-magic-numbers": [
        "warn",
        {
          ignore: [0, 1, -1],
          ignoreArrayIndexes: true,
          enforceConst: true,
        },
      ],
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
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
