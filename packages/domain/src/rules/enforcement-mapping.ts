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
    ruleId: "test-infrastructure",
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

  // ── Testing standards: co-location, suite must pass ──────────────────────
  {
    ruleId: "testing-standards",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-tests-directories",
        description:
          "Warns when test files are placed inside __tests__ directories; encourages co-located *.test.ts files",
        configPath: "eslint-rules/no-tests-directories.js",
        portability: "portable",
      },
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

  // ── Git safety (destructive operation guard) ──────────────────────────────
  {
    ruleId: "git-safety",
    mechanisms: [
      {
        type: "eslint",
        name: "custom/no-unsafe-git-exec",
        description:
          "Errors on direct shell execution of git commands without the structured git-safety skill protocol; prevents untimed destructive git operations",
        configPath: "eslint-rules/no-unsafe-git-exec.js",
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

  // ── Claude Code merge gates (PreToolUse[session_pr_merge]) ─────────────────
  // mt#975: this block + the two below were added to give the bidirectional
  // parity test (see enforcement-mapping.test.ts "settings.json parity") full
  // coverage of every hook registered in .claude/settings.json — the exact
  // defect class that let require-acceptance-tests-before-done.ts sit
  // unregistered and undetected until this task deleted it.

  {
    ruleId: "subagent-merge-capability",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_pr_merge]: block-subagent-merge-without-grant.ts",
        description:
          "Blocks a subagent from calling session_pr_merge unless the main agent has granted merge capability for that session; prevents subagents from merging on their own authority",
        configPath: ".claude/hooks/block-subagent-merge-without-grant.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "execution-evidence-gate",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_pr_merge]: require-execution-evidence-before-merge.ts",
        description:
          "Blocks session_pr_merge when new test files lack an 'Execution evidence:' cross-reference to each executable acceptance test. Successor to the deleted require-acceptance-tests-before-done.ts (mt#975): gates at merge time instead of the DONE transition, and is satisfiable (the earlier hook was not). MINSKY_SKIP_AT_COVERAGE is the documented, audit-logged override.",
        configPath: ".claude/hooks/require-execution-evidence-before-merge.ts",
        portability: "harness-trapped",
      },
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_pr_create]: inject-success-criteria.ts",
        description:
          "Surfaces the bound task's '## Success Criteria' verbatim at PR-creation time, so they are confronted at the moment of shipping rather than recalled from having written them (mt#3350; mem#736 R2). Paired with the merge-time success-criteria cross-reference inside require-execution-evidence-before-merge.ts, which warns when a mechanically-executable criterion's output is absent from the 'Execution evidence:' block and carries no '[scN-deferred: mt#NNNN]' marker. Both halves are log-only per the mt#2263 calibration ladder; MINSKY_SKIP_SC_COVERAGE is the documented override for the merge-time half. Exists because the prose tier for this class (/implement-task §7 item 5) has a measured 14x recurrence across 13 PRs.",
        configPath: ".claude/hooks/inject-success-criteria.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "deploy-verification-gate",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_pr_merge]: require-deploy-verification-before-merge.ts",
        description:
          "Blocks session_pr_merge on deploy/infra PRs and tray usability-claim PRs that lack a deploy-verification commitment. MINSKY_SKIP_DEPLOY_VERIFY / MINSKY_SKIP_USABILITY_CLAIM_CHECK are the documented overrides.",
        configPath: ".claude/hooks/require-deploy-verification-before-merge.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "growth-justification-gate",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_pr_merge]: require-growth-justification-before-merge.ts",
        description:
          "Blocks session_pr_merge on rules-touching PRs that grow CLAUDE.md past its size budget without an explicit justification. MINSKY_SKIP_SIZE_JUSTIFICATION is the documented override.",
        configPath: ".claude/hooks/require-growth-justification-before-merge.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "out-of-band-merge-guard",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_pr_merge|Bash]: block-out-of-band-merge.ts",
        description:
          "Blocks merge attempts whose PR body couples unconfirmed out-of-band steps. MINSKY_ACK_OOB_MERGE is the documented override.",
        configPath: ".claude/hooks/block-out-of-band-merge.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // ── Claude Code dispatch/session gates ──────────────────────────────────────

  {
    ruleId: "nested-fork-dispatch-guard",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Agent]: block-nested-fork-dispatch.ts",
        description:
          "Denies a nested fork-type Agent dispatch (a subagent dispatching another fork) unless a live dispatch-intent declaration already covers the calling session. MINSKY_ALLOW_NESTED_FORK is the documented override (mt#3045).",
        configPath: ".claude/hooks/block-nested-fork-dispatch.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "bypass-merge-guard",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Bash]: block-subagent-bypass-merge.ts",
        description:
          "Blocks a subagent from bypass-merging via `gh api PUT .../merge`. MINSKY_FORCE_BYPASS is the documented override.",
        configPath: ".claude/hooks/block-subagent-bypass-merge.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "required-checks-guard",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Bash]: require-checks-on-bypass-merge.ts",
        description:
          "Blocks a bypass-merge unless required CI status checks have passed. MINSKY_SKIP_REQUIRED_CHECKS is the documented override.",
        configPath: ".claude/hooks/require-checks-on-bypass-merge.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "parallel-work-guard",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_start|tasks_dispatch|tasks_create]: parallel-work-guard.ts",
        description:
          "Blocks starting parallel work on a task another actor already has an open PR/session for, and blocks creating a duplicate sibling task. MINSKY_FORCE_PARALLEL / MINSKY_FORCE_DUPLICATE_OK are the documented overrides.",
        configPath: ".claude/hooks/parallel-work-guard.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "spec-read-gate",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[tasks_status_set|session_start|tasks_dispatch|asks_create|asks_edit]: check-task-spec-read.ts",
        description:
          "Blocks a status-transition or session-binding operation on a task whose spec was not read this conversation. On the ask surfaces (asks_create/asks_edit, mt#4551) the same check ADVISES instead of blocking: an ask recommends a task rather than acting on one, and denying one can strand an escalation. MINSKY_SKIP_SPEC_READ_CHECK is the documented override for both legs.",
        configPath: ".claude/hooks/check-task-spec-read.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "branch-freshness-gate",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_commit|session_pr_create|session_pr_edit]: check-branch-fresh.ts",
        description:
          "Blocks a commit/PR operation when the session branch is behind main. MINSKY_SKIP_FRESHNESS is the documented override.",
        configPath: ".claude/hooks/check-branch-fresh.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "generated-file-edit-guard",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Edit|Write|session_*_file]: check-generated-file-edit.ts",
        description:
          "Blocks direct edits to generated files (e.g. .claude/hooks/* compiled from .minsky/hooks/*). MINSKY_FORCE_EDIT_GENERATED is the documented override.",
        configPath: ".claude/hooks/check-generated-file-edit.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "dispatch-intent-write-gate",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[session_commit|session_pr_create|session_pr_edit|session_*_file]: dispatch-intent-write-gate.ts",
        description:
          "Denies session-mutating/PR-mutating tool calls for a session under a declared read-only dispatch intent, regardless of which agent_id makes the call (mt#2865).",
        configPath: ".claude/hooks/dispatch-intent-write-gate.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "task-status-workflow-protocol",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[tasks_status_set]: tasks-status-set-guard.ts",
        description:
          "Validates task status state-machine transitions on tasks_status_set (e.g. denies setting DONE directly from a session). Occupies the matcher slot the deleted require-acceptance-tests-before-done.ts never actually held (mt#975) — this is the real gate on that tool call.",
        configPath: ".claude/hooks/tasks-status-set-guard.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "ask-permission-bridge",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Bash]: ask-permission-bridge.ts",
        description:
          "Grants ALLOW for actions covered by an approved Ask (mt#2823). A sibling hook's deny decision still outranks this allow — harness deny-precedence.",
        configPath: ".claude/hooks/ask-permission-bridge.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "main-workspace-edit-guard",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Edit|Write|NotebookEdit]: require-session-for-main-workspace-edits.ts",
        description:
          "Blocks Edit/Write/NotebookEdit against files inside the main workspace outside any session workspace; enforces that all code edits happen in a session (mt#1099).",
        configPath: ".claude/hooks/require-session-for-main-workspace-edits.ts",
        portability: "harness-trapped",
      },
    ],
  },

  {
    ruleId: "loop-preflight-check",
    mechanisms: [
      {
        type: "claude-code-hook",
        name: "PreToolUse[Skill]: loop-preflight-pr-merge-check.ts",
        description:
          "Blocks invoking the /loop skill against a PR or task already in a terminal (merged/closed/done) state, preventing hours of orphan-commit iteration on a closed branch (mt#1496).",
        configPath: ".claude/hooks/loop-preflight-pr-merge-check.ts",
        portability: "harness-trapped",
      },
    ],
  },

  // ── Claude Code operational hooks (not enforcement — UX/automation) ────────
  // See NON_ENFORCEMENT_CLAUDE_HOOKS below for the full, test-checked list of
  // settings.json-registered hooks (dispatchers, observers, operational
  // automation) deliberately excluded from this array.

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

export interface NonEnforcementHook {
  /** Path as it appears in a settings.json "command" value, e.g. ".claude/hooks/foo.ts". */
  configPath: string;
  /** Why this hook is deliberately excluded from ENFORCEMENT_MAPPINGS. */
  reason: string;
}

/**
 * Claude Code hooks registered in .claude/settings.json that are deliberately NOT
 * enforcement mechanisms: guard-dispatcher entrypoints that fan out to
 * individually-registered GUARD_REGISTRY sub-guards (not 1:1 with a single rule),
 * observers/recorders that make no permission decision, calibration-mode
 * detectors that default to log-only, and pure UX/operational automation.
 *
 * mt#975: this list exists so the settings.json parity test (see
 * enforcement-mapping.test.ts) can require every registered hook to be
 * EXPLICITLY triaged into either ENFORCEMENT_MAPPINGS or here — closing the
 * gap that let require-acceptance-tests-before-done.ts sit in the tree,
 * unregistered in settings.json AND untracked in enforcement-mapping.ts,
 * until this task found and deleted it. A hook landing in neither place now
 * fails the test instead of rotting silently.
 */
export const NON_ENFORCEMENT_CLAUDE_HOOKS: NonEnforcementHook[] = [
  // ── Guard-dispatcher entrypoints (ADR-028): fan out to GUARD_REGISTRY, not 1:1 with a rule ──
  {
    configPath: ".claude/hooks/dispatch-pretooluse.ts",
    reason:
      "PreToolUse guard-dispatcher; routes to individually-registered GUARD_REGISTRY sub-guards (e.g. check-guessed-session-path), not itself one rule's mechanism",
  },
  {
    configPath: ".claude/hooks/dispatch-stop.ts",
    reason:
      "Stop guard-dispatcher; routes to GUARD_REGISTRY Stop-event sub-guards (e.g. turn-end-retro-scan)",
  },
  {
    configPath: ".claude/hooks/dispatch-userpromptsubmit.ts",
    reason:
      "UserPromptSubmit guard-dispatcher; routes to 20+ GUARD_REGISTRY sub-guards (detectors, injectors, calibration-review cadence)",
  },

  // ── Display transforms: rewrite what is shown, decide nothing ──
  {
    configPath: ".claude/hooks/linkify-message-display.ts",
    reason:
      "MessageDisplay text transform (mt#2565); rewrites bare mt#NNNN / PR #N into deeplinks as a message is displayed and enforces no rule — it never denies, never injects context, and leaves the stored transcript untouched",
  },

  // ── Calibration-mode detectors: default to log-only, not yet graduated to blocking ──
  {
    configPath: ".claude/hooks/warn-bare-prohibition-dispatch.ts",
    reason:
      "Calibration-first observer (mt#3162); graduation to blocking is tracked separately at mt#3167 per hook-observers.mdc",
  },

  // ── Pure observers/recorders: no permission decision, fail-open ──
  {
    configPath: ".claude/hooks/record-conversation-run-state.ts",
    reason:
      "mt#3161 run-state writer; explicitly an observer per its own settings.json annotations, fail-open on every event",
  },
  {
    configPath: ".claude/hooks/verify-subagent-model.ts",
    reason:
      "mt#3257 subagent model-tier verification — PostToolUse observer that warns on requested-vs-resolved mismatch; no permission decision, fail-open (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/warn-peer-task-activity.ts",
    reason:
      "mt#4494 peer-activity advisory — reads the task event ledger on tasks_status_set and injects additionalContext naming any session.started / recent status change; never denies, fail-open on a degraded DB path. Deliberately advisory rather than blocking: denying is the prevention side of the substrate RFC's Open question 4 (Notion 367937f0, Draft), a principal-level design-philosophy question this hook must not settle as a side effect",
  },
  {
    configPath: ".claude/hooks/warn-stale-forward-reference.ts",
    reason:
      "mt#4535 stale-forward-reference advisory — on a DONE transition only, scans the ADR and rule corpus for paragraphs that describe this task's deliverable as future work and injects them as reconciliation candidates; never denies, fails open on a degraded DB path or an unreadable corpus. Log-only by design: the description-path match is a title-token heuristic whose false-positive rate against the corpus is unmeasured, so the calibration record ships before any enforcement",
  },
  {
    configPath: ".claude/hooks/record-subagent-invocation.ts",
    reason:
      "SubagentStop recording — writes dispatch-row columns, makes no permission decision (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/transcript-ingest-on-session-end.ts",
    reason:
      "Ingests the finished transcript at SessionEnd — recording, not enforcement (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/guard-events-ingest-on-session-end.ts",
    reason:
      "mt#4035 guard/calibration exhaust ingest push at SessionEnd — recording, not enforcement; the correctness layer is the cockpit sweep, not this hook (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/post-merge-unasked-direction-scan.ts",
    reason: "Post-merge scanner for unasked directions — detector, log-only (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/deploy-verification-after-merge.ts",
    reason:
      "Post-merge companion reminder to require-deploy-verification-before-merge.ts; no deny logic — the merge it would gate has already happened",
  },
  {
    configPath: ".claude/hooks/stamp-session-creator-link.ts",
    reason:
      "Stamps the workspace<->conversation link at session_start — recording, not enforcement (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/drive-pr-to-convergence.ts",
    reason:
      "Reminds the agent to watch for bot review — advisory, no permission decision (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/drive-ready-to-implementation.ts",
    reason:
      "Reminds the agent to walk READY -> /implement-task — advisory, no permission decision (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/gate-walk-provenance.ts",
    reason:
      'Merge-seam recorder (mt#1880): reads whether the bound task has a task.status_changed → READY row and writes one calibration record. Record-only by ADR-042 §Posture — never denies, never injects, and its fire-log decision is the literal type "allow" — so it is not any rule\'s enforcement mechanism. Registered at BOTH merge surfaces (session_pr_merge and the gh-api bypass) because the bypass is where an ungated task most plausibly reaches main; a posture flip is operator-reserved, and this entry moves to ENFORCEMENT_MAPPINGS if that ever happens',
  },
  {
    configPath: ".claude/hooks/unowned-finding-scan.ts",
    reason:
      "Records findings-section items with no declared owner at the DONE transition — log-only calibration, no permission decision (mt#4246, hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/stamp-pr-author-link.ts",
    reason:
      "Stamps the workspace<->conversation link at session_pr_create — recording, not enforcement (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/stamp-ask-conversation.ts",
    reason:
      "Stamps the ask<->conversation attribution at asks_create (mt#3564) — recording, not enforcement; writes one local JSON file and denies nothing (hook-observers.mdc)",
  },
  {
    configPath: ".claude/hooks/bridge-memory-retirement.ts",
    reason: "Retires stale bridge memories post-merge — housekeeping automation, no deny logic",
  },
  {
    configPath: ".claude/hooks/two-strikes-record.ts",
    reason:
      "Records tool-error streak data for the 2-strikes rule; the rule itself is agent-followed discipline, not hook-enforced",
  },

  // ── Pure UX/operational automation ──
  {
    configPath: ".claude/hooks/session-start.ts",
    reason:
      "Bootstraps remote session environments (bun install, gitleaks) — operational, not enforcement",
  },
  {
    configPath: ".claude/hooks/post-session-start.ts",
    reason: "Sets the iTerm2 tab color/label from task info — UX automation, not enforcement",
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
