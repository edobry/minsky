/**
 * Maps rule IDs to their programmatic enforcement mechanisms.
 * Used for defense-in-depth: agent instructions (prevention) + linting (detection).
 *
 * Rule IDs correspond to filenames in .cursor/rules/ (without the .mdc extension).
 * Enforcement mechanisms are sourced from:
 *   - eslint.config.js (custom/* and standard ESLint rules)
 *   - eslint-rules/ (custom ESLint rule implementations)
 *   - .husky/pre-commit → src/hooks/pre-commit.ts
 *   - .husky/commit-msg → src/hooks/commit-msg.ts
 *   - .husky/pre-push
 *   - .github/workflows/ci.yml
 *   - scripts/ (standalone validation scripts)
 */

export interface EnforcementMechanism {
  type: "eslint" | "git-hook" | "ci-check" | "test" | "script";
  name: string;
  description: string;
  configPath?: string;
}

export interface EnforcementMapping {
  ruleId: string;
  mechanisms: EnforcementMechanism[];
}

export const ENFORCEMENT_MAPPINGS: EnforcementMapping[] = [
  // ── File size ──────────────────────────────────────────────────────────────
  {
    ruleId: "file-size",
    mechanisms: [
      {
        type: "eslint",
        name: "max-lines (warn @ 400)",
        description: "Warns when a file exceeds 400 non-blank, non-comment lines",
        configPath: "eslint.config.js",
      },
      {
        type: "eslint",
        name: "max-lines (error @ 1500)",
        description: "Errors when a file exceeds 1500 non-blank, non-comment lines",
        configPath: "eslint.config.js",
      },
    ],
  },

  // ── Template literals ─────────────────────────────────────────────────────
  {
    ruleId: "template-literals",
    mechanisms: [
      {
        type: "eslint",
        name: "prefer-template",
        description: "Errors on string concatenation with + operator; requires template literals",
        configPath: "eslint.config.js",
      },
    ],
  },

  // ── Variable naming (underscore-prefix mismatch) ──────────────────────────
  {
    ruleId: "variable-naming-protocol",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-underscore-prefix-mismatch",
        description:
          "Errors when a variable is declared with an underscore prefix but used without it (or vice versa)",
        configPath: "eslint-rules/no-underscore-prefix-mismatch.js",
      },
      {
        type: "git-hook",
        name: "pre-commit: check-variable-naming",
        description:
          "Pre-commit hook runs scripts/check-variable-naming.ts to detect catch-block, function-param, and destructuring naming issues",
        configPath: "src/hooks/pre-commit.ts",
      },
    ],
  },

  // ── Naming conventions (process-thinking names) ───────────────────────────
  {
    ruleId: "naming-conventions",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-underscore-prefix-mismatch",
        description:
          "Partial enforcement: prevents declaration/usage mismatches caused by incorrect underscore prefixing",
        configPath: "eslint-rules/no-underscore-prefix-mismatch.js",
      },
    ],
  },

  // ── Git operation safety ──────────────────────────────────────────────────
  {
    ruleId: "git-usage-policy",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-unsafe-git-exec",
        description:
          "Errors on execAsync/exec calls containing git network operations (push/pull/fetch/clone) without timeout protection; warns on other git operations",
        configPath: "eslint-rules/no-unsafe-git-exec.js",
      },
    ],
  },

  // ── Test patterns: no Jest ────────────────────────────────────────────────
  {
    ruleId: "bun-test-patterns",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-jest-patterns",
        description:
          "Errors on Jest imports and API usage (jest.fn, jest.mock, jest.spyOn, .mockReturnValue, etc.) in test files; provides auto-fixes to Bun equivalents",
        configPath: "eslint-rules/no-jest-patterns.js",
      },
    ],
  },

  // ── Test patterns: no real filesystem in tests ────────────────────────────
  {
    ruleId: "testing-boundaries",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-real-fs-in-tests",
        description:
          "Warns on real filesystem imports and operations (fs, tmpdir, Date.now for paths, dynamic imports) inside test files; strict mode catches all problematic patterns",
        configPath: "eslint-rules/no-real-fs-in-tests.js",
      },
    ],
  },

  // ── Test patterns: no global module mocks ────────────────────────────────
  {
    ruleId: "test-infrastructure-patterns",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-global-module-mocks",
        description:
          "Warns on mock.module() calls placed at module-level (outside test blocks) to prevent cross-test interference; only tests/setup.ts is exempt",
        configPath: "eslint-rules/no-global-module-mocks.js",
      },
      {
        type: "eslint",
        name: "custom/no-unreliable-factory-mocks",
        description:
          "Warns on async factory mock patterns that can introduce race conditions in tests",
        configPath: "eslint-rules/no-unreliable-factory-mocks.js",
      },
      {
        type: "eslint",
        name: "custom/no-cli-execution-in-tests",
        description:
          "Warns when test files execute the CLI instead of calling domain functions directly",
        configPath: "eslint-rules/no-cli-execution-in-tests.js",
      },
      {
        type: "eslint",
        name: "custom/no-unwaited-async-factory",
        description:
          "Errors when known async factory functions (e.g. createSessionProvider) are called without await, preventing Promise-instead-of-value bugs",
        configPath: "eslint-rules/no-unwaited-async-factory.js",
      },
    ],
  },

  // ── Test organisation: co-located test files ─────────────────────────────
  {
    ruleId: "test-organization",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-tests-directories",
        description:
          "Warns when test files are placed inside __tests__ directories; encourages co-located *.test.ts files",
        configPath: "eslint-rules/no-tests-directories.js",
      },
    ],
  },

  // ── Type safety: excessive as-unknown ────────────────────────────────────
  {
    ruleId: "robust-error-handling",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-excessive-as-unknown",
        description:
          "Warns on high-risk 'as unknown' type assertions that mask real type errors; allows legitimate patterns via configurable allowedPatterns",
        configPath: "eslint-rules/no-excessive-as-unknown.js",
      },
    ],
  },

  // ── Constants / magic string duplication ─────────────────────────────────
  {
    ruleId: "constants-management",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-magic-string-duplication",
        description:
          "Warns when string literals of 15+ characters appear 3+ times in the same file, encouraging extraction to named constants",
        configPath: "eslint-rules/no-magic-string-duplication.js",
      },
    ],
  },

  // ── Import style: no file extensions ─────────────────────────────────────
  {
    ruleId: "bun_over_node",
    mechanisms: [
      {
        type: "eslint",
        name: "no-restricted-imports (extensionless)",
        description:
          "Errors on local imports with explicit .ts/.js/.tsx/.jsx/.mjs/.cjs extensions; enforces Bun-native extensionless import style",
        configPath: "eslint.config.js",
      },
    ],
  },

  // ── Code formatting ───────────────────────────────────────────────────────
  {
    ruleId: "user-preferences",
    mechanisms: [
      {
        type: "eslint",
        name: "prettier/prettier",
        description:
          "Errors on any formatting that diverges from the project Prettier config (double quotes, 2-space indent, 100-char line width, ES5 trailing commas, LF endings)",
        configPath: "eslint.config.js",
      },
      {
        type: "git-hook",
        name: "pre-commit: format",
        description:
          "Pre-commit hook runs `bun run format` (Prettier) over all staged files before committing",
        configPath: "src/hooks/pre-commit.ts",
      },
      {
        type: "ci-check",
        name: "CI: format:check",
        description: "GitHub Actions CI runs `bun run format:check` on every push/PR to main",
        configPath: ".github/workflows/ci.yml",
      },
    ],
  },

  // ── Commit message format ─────────────────────────────────────────────────
  {
    ruleId: "commit-all-changes-rule",
    mechanisms: [
      {
        type: "git-hook",
        name: "commit-msg hook",
        description:
          "Validates commit messages against conventional-commits format, rejects placeholder messages (wip, fix, update, etc.), and prevents title duplication in the body",
        configPath: "src/hooks/commit-msg.ts",
      },
    ],
  },

  // ── Secret scanning ───────────────────────────────────────────────────────
  {
    ruleId: "operational-safety-dry-run-first",
    mechanisms: [
      {
        type: "git-hook",
        name: "pre-commit: gitleaks",
        description:
          "Pre-commit hook runs gitleaks to scan staged changes for secrets before every commit",
        configPath: "src/hooks/pre-commit.ts",
      },
    ],
  },

  // ── Test suite must pass ──────────────────────────────────────────────────
  {
    ruleId: "no-skipped-tests",
    mechanisms: [
      {
        type: "git-hook",
        name: "pre-commit: unit tests",
        description:
          "Pre-commit hook runs the full unit-test suite (bun test --bail) and blocks the commit on any failure",
        configPath: "src/hooks/pre-commit.ts",
      },
      {
        type: "git-hook",
        name: "pre-push: tests",
        description: "Pre-push hook runs the full test suite and blocks the push if any tests fail",
        configPath: ".husky/pre-push",
      },
      {
        type: "ci-check",
        name: "CI: test",
        description: "GitHub Actions CI runs `bun run test` on every push/PR to main",
        configPath: ".github/workflows/ci.yml",
      },
    ],
  },

  // ── ESLint (full) ─────────────────────────────────────────────────────────
  {
    ruleId: "dont-ignore-errors",
    mechanisms: [
      {
        type: "git-hook",
        name: "pre-commit: ESLint validation",
        description:
          "Pre-commit hook runs ESLint in JSON mode; blocks commit on any error and on warning counts above 100",
        configPath: "src/hooks/pre-commit.ts",
      },
      {
        type: "ci-check",
        name: "CI: lint",
        description: "GitHub Actions CI runs `bun run lint` on every push/PR to main",
        configPath: ".github/workflows/ci.yml",
      },
    ],
  },
];

/**
 * Get enforcement mechanisms for a single rule by its ID.
 */
export function getEnforcement(ruleId: string): EnforcementMapping | undefined {
  return ENFORCEMENT_MAPPINGS.find((m) => m.ruleId === ruleId);
}

/**
 * Get all rule IDs that have at least one programmatic enforcement mechanism.
 */
export function getEnforcedRules(): string[] {
  return ENFORCEMENT_MAPPINGS.map((m) => m.ruleId);
}

/**
 * Return the subset of allRuleIds that have NO programmatic enforcement.
 * These are candidates for adding lint rules or hooks.
 */
export function getUnenforced(allRuleIds: string[]): string[] {
  const enforced = new Set(getEnforcedRules());
  return allRuleIds.filter((id) => !enforced.has(id));
}
