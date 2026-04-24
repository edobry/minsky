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
 *   - .claude/settings.json (Claude Code hooks)
 *   - src/adapters/mcp/ (MCP tool handler validation)
 *
 * Git hook propagation (empirically verified 2026-04-23 in session daa49e7c):
 *   - .git/config sets core.hooksPath = .husky/_
 *   - .husky/_/ contains executable hook scripts (rwxr-xr-x) for all git events
 *   - Active project hooks in .husky/: commit-msg, post-commit, post-merge, pre-commit, pre-push
 *   - `bun install` runs `husky` via the `prepare` script → hooks are installed in clones
 *   - Empirical test: `session_commit` on a file with `const x: number = "not a number"`
 *     → pre-commit hook ran tsgo, detected TS2322, and blocked the commit
 *   - Conclusion: git hooks fire correctly in session clones via `session_commit`
 */

export interface EnforcementMechanism {
  type:
    | "eslint"
    | "git-hook"
    | "ci-check"
    | "test"
    | "script"
    | "claude-code-hook"
    | "mcp-tool-logic";
  name: string;
  description: string;
  configPath?: string;
  /**
   * "portable"        — fires regardless of agent harness (git hooks, ESLint, CI, MCP tool logic)
   * "harness-trapped" — only fires when running inside the Claude Code harness
   */
  portability: "portable" | "harness-trapped";
}

export interface EnforcementMapping {
  ruleId: string;
  mechanisms: EnforcementMechanism[];
}

// Note: some rules have been deleted from .minsky/rules/ (e.g. file-size,
// template-literals, variable-naming-protocol, commit-all-changes-rule). Their
// programmatic enforcement (ESLint rules, git hooks) continues to function
// without explicit mapping here — this list only covers rules that still exist
// as agent-facing .mdc files in .cursor/rules/.
export const ENFORCEMENT_MAPPINGS: EnforcementMapping[] = [
  // ── Naming conventions (process-thinking names) ───────────────────────────
  {
    ruleId: "meta-cognitive-boundary-protocol",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-underscore-prefix-mismatch",
        description:
          "Partial enforcement: prevents declaration/usage mismatches caused by incorrect underscore prefixing",
        configPath: "eslint-rules/no-underscore-prefix-mismatch.js",
        portability: "portable",
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
        portability: "portable",
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
        portability: "portable",
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
        portability: "portable",
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
        portability: "portable",
      },
      {
        type: "eslint",
        name: "custom/no-unreliable-factory-mocks",
        description:
          "Warns on async factory mock patterns that can introduce race conditions in tests",
        configPath: "eslint-rules/no-unreliable-factory-mocks.js",
        portability: "portable",
      },
      {
        type: "eslint",
        name: "custom/no-cli-execution-in-tests",
        description:
          "Warns when test files execute the CLI instead of calling domain functions directly",
        configPath: "eslint-rules/no-cli-execution-in-tests.js",
        portability: "portable",
      },
      {
        type: "eslint",
        name: "custom/no-unwaited-async-factory",
        description:
          "Errors when known async factory functions (e.g. createSessionProvider) are called without await, preventing Promise-instead-of-value bugs",
        configPath: "eslint-rules/no-unwaited-async-factory.js",
        portability: "portable",
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
        portability: "portable",
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
        portability: "portable",
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
        portability: "portable",
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
        portability: "portable",
      },
      {
        type: "git-hook",
        name: "pre-commit: format",
        description:
          "Pre-commit hook runs `bun run format` (Prettier) over all staged files before committing",
        configPath: "src/hooks/pre-commit.ts",
        portability: "portable",
      },
      {
        type: "ci-check",
        name: "CI: format:check",
        description: "GitHub Actions CI runs `bun run format:check` on every push/PR to main",
        configPath: ".github/workflows/ci.yml",
        portability: "portable",
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
        portability: "portable",
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
        portability: "portable",
      },
      {
        type: "git-hook",
        name: "pre-push: tests",
        description: "Pre-push hook runs the full test suite and blocks the push if any tests fail",
        configPath: ".husky/pre-push",
        portability: "portable",
      },
      {
        type: "ci-check",
        name: "CI: test",
        description: "GitHub Actions CI runs `bun run test` on every push/PR to main",
        configPath: ".github/workflows/ci.yml",
        portability: "portable",
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
        portability: "portable",
      },
      {
        type: "ci-check",
        name: "CI: lint",
        description: "GitHub Actions CI runs `bun run lint` on every push/PR to main",
        configPath: ".github/workflows/ci.yml",
        portability: "portable",
      },
    ],
  },

  // ── Claude Code hooks ──────────────────────────────────────────────────────

  // PreToolUse: prompt watermark gate
  {
    ruleId: "prompt-watermark-enforcement",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Agent]: check-prompt-watermark.ts",
        description:
          "Blocks subagent dispatch (Agent tool calls) that lack the minsky:prompt:v1 watermark, ensuring all subagent prompts are generated via session.generate_prompt",
        configPath: ".claude/hooks/check-prompt-watermark.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // PreToolUse: block raw git/gh CLI
  {
    ruleId: "mcp-tool-preference",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Bash]: block-git-gh-cli.ts",
        description:
          "Blocks raw git and gh CLI invocations in Bash tool calls when MCP equivalents exist; enforces use of mcp__minsky__* and mcp__github__* tools",
        configPath: ".claude/hooks/block-git-gh-cli.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // PreToolUse: require review before merge
  {
    ruleId: "review-before-merge",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_pr_merge]: require-review-before-merge.ts",
        description:
          "Blocks session_pr_merge unless the PR has a posted GitHub review containing a Spec verification section; prevents merging without human review",
        configPath: ".claude/hooks/require-review-before-merge.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // PreToolUse: block GitHub MCP PR writes
  {
    ruleId: "pr-identity-provenance",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[mcp__github__*_pull_request*]: block-github-mcp-pr-writes.ts",
        description:
          "Blocks direct GitHub MCP PR-write operations (create, update, merge, review_write) in favor of Minsky session equivalents; ensures PR provenance is tracked",
        configPath: ".claude/hooks/block-github-mcp-pr-writes.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // PostToolUse: incremental typecheck on file edits
  {
    ruleId: "incremental-typecheck",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PostToolUse[Write|Edit|session_*_file|session_search_replace]: typecheck-on-edit.ts",
        description:
          "Runs tsgo (native TypeScript compiler) after every file write or edit; surfaces type errors immediately without waiting for pre-commit",
        configPath: ".claude/hooks/typecheck-on-edit.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // PostToolUse: validate task spec structure
  {
    ruleId: "task-spec-validation",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PostToolUse[tasks_create]: validate-task-spec.ts",
        description:
          "Warns after tasks_create if the spec body lacks required sections (Summary, Success Criteria, Acceptance Tests); blocks creation of under-specified tasks",
        configPath: ".claude/hooks/validate-task-spec.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // PostToolUse: pull main after merge
  {
    ruleId: "post-merge-sync",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PostToolUse[session_pr_merge|merge_pull_request]: post-merge-pull.ts",
        description:
          "Pulls the latest main branch into the local workspace after a PR merge; keeps the main workspace current without manual git pull",
        configPath: ".claude/hooks/post-merge-pull.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // PreToolUse: require acceptance tests before marking DONE
  {
    ruleId: "acceptance-test-gate",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[tasks_status_set]: require-acceptance-tests-before-done.ts",
        description:
          "Blocks tasks_status_set to DONE if the task spec has an Acceptance Tests section with executable commands that haven't been acknowledged as run",
        configPath: ".claude/hooks/require-acceptance-tests-before-done.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // Stop/SubagentStop: typecheck gate before completion
  {
    ruleId: "typecheck-gate",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "Stop/SubagentStop: typecheck-on-stop.ts",
        description:
          "Runs tsgo on Stop and SubagentStop events; blocks task/subagent completion if TypeScript errors are present, ensuring no type regressions are left behind",
        configPath: ".claude/hooks/typecheck-on-stop.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // ── Claude Code operational hooks (not enforcement — UX/automation) ────────
  // auto-session-title.ts (UserPromptSubmit) — sets Claude Code session title from task info
  // post-session-start.ts (PostToolUse[session_start]) — sets iTerm2 tab color/label
  // session-start.ts (SessionStart) — bootstraps remote session environments (bun install, gitleaks)

  // ── MCP tool-level enforcement ─────────────────────────────────────────────

  // guardProjectSetup(): config presence gate
  {
    ruleId: "project-setup-guard",
    mechanisms: [
      {
        type: "mcp-tool-logic",
        name: "guardProjectSetup()",
        description:
          "Blocks non-exempt MCP tool commands when the project configuration file (.minsky/config.yaml) is absent; prevents silent failures from unconfigured repositories",
        configPath: "src/domain/configuration/guard.ts",
        portability: "portable",
      },
    ],
  },

  // validateNoPrExists(): duplicate PR prevention
  {
    ruleId: "duplicate-pr-prevention",
    mechanisms: [
      {
        type: "mcp-tool-logic",
        name: "validateNoPrExists()",
        description:
          "Checks for an existing open PR on the session branch before creating a new one; blocks duplicate PR creation and surfaces the existing PR URL",
        configPath: "src/adapters/shared/commands/session/pr-create-command.ts",
        portability: "portable",
      },
    ],
  },

  // command.validate() pipeline
  {
    ruleId: "command-validation",
    mechanisms: [
      {
        type: "mcp-tool-logic",
        name: "command.validate() pipeline",
        description:
          "Per-command input validation run before handler execution in the shared command registry; validates required fields, enum values, and cross-field constraints for every MCP tool invocation",
        configPath: "src/adapters/mcp/shared-command-integration.ts",
        portability: "portable",
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
