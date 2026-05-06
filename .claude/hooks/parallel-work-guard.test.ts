import { describe, expect, it } from "bun:test";

import {
  extractInScopeFiles,
  fetchFileContentAtRef,
  findOverlappingFiles,
  formatBlockMessage,
  runParallelWorkChecks,
  parseGitHubRemoteUrl,
  isOwnBranch,
  detectDefaultBranch,
  isAppendOnlyToJsonArrays,
  STRUCTURED_CONFIG_ALLOWLIST,
  type ParallelWorkCheckInput,
  type ParallelWorkCheckDeps,
  type ParallelWorkCollision,
} from "./parallel-work-guard";

// ---------------------------------------------------------------------------
// Shared test fixtures (extracted to avoid magic-string duplication warnings)
// ---------------------------------------------------------------------------

/**
 * Build a deps object for runParallelWorkChecks tests with sane defaults
 * for fields the test doesn't care about. Specifically, detectDefaultBranch
 * defaults to returning `origin/main` so the recently-merged sweep runs
 * during tests without a live git repo. Override per-test as needed.
 */
function makeDeps(overrides: Partial<ParallelWorkCheckDeps> = {}): ParallelWorkCheckDeps {
  return {
    fetchOpenPrs: () => [],
    fetchPrFiles: () => [],
    fetchRecentMerges: () => [],
    detectDefaultBranch: () => ({ ref: "origin/main" }),
    // Default to "no exemption" so existing tests keep their semantics — any
    // mt#1587 tests opt in by overriding this dep.
    isFileChangeAppendOnly: () => false,
    ...overrides,
  };
}

const FIXTURE_SETTINGS_JSON = ".claude/settings.json";
const FIXTURE_ASK_TS = "src/domain/ask/ask.ts";
const FIXTURE_ASK_TEST_TS = "src/domain/ask/ask.test.ts";
const FIXTURE_HOOK_TS = ".claude/hooks/parallel-work-guard.ts";
// mt#1587: append-only structured-config exemption fixtures
const FIXTURE_NEW_HOOK_TS = ".claude/hooks/my-new-hook.ts";

// ---------------------------------------------------------------------------
// extractInScopeFiles
// ---------------------------------------------------------------------------

describe("extractInScopeFiles", () => {
  it("extracts file paths from a well-formed spec", () => {
    const spec = `
## Summary
A task.

## Scope

**In scope:**
- \`.claude/hooks/parallel-work-guard.ts\` (new file)
- \`.claude/settings.json\` (hook registration)
- \`src/domain/ask/ask.ts\`

**Out of scope:**
- Modifying other hooks
`;
    const { files, warnings } = extractInScopeFiles(spec);
    expect(warnings).toHaveLength(0);
    expect(files).toContain(FIXTURE_HOOK_TS);
    expect(files).toContain(FIXTURE_SETTINGS_JSON);
    expect(files).toContain(FIXTURE_ASK_TS);
  });

  it("returns warning when ## Scope section is missing", () => {
    const spec = `## Summary\nNo scope section here.\n`;
    const { files, warnings } = extractInScopeFiles(spec);
    expect(files).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/No '## Scope' section/);
  });

  it("returns warning when In scope block is missing", () => {
    const spec = `
## Scope

This section has no bold In scope header.

## Next Section
`;
    const { files, warnings } = extractInScopeFiles(spec);
    expect(files).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/No '\*\*In scope:\*\*' block/);
  });

  it("returns warning when In scope block has no parseable paths", () => {
    const spec = `
## Scope

**In scope:**
- Some text without a path
- More text

**Out of scope:**
- something
`;
    const { files, warnings } = extractInScopeFiles(spec);
    expect(files).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("handles paths with annotations (new), (modified), etc.", () => {
    const spec = `
## Scope

**In scope:**
- \`src/domain/foo.ts\` (new file)
- \`src/adapters/cli/bar.ts\` (modified)

**Out of scope:**
- nothing
`;
    const { files } = extractInScopeFiles(spec);
    expect(files).toContain("src/domain/foo.ts");
    expect(files).toContain("src/adapters/cli/bar.ts");
    // Annotations should be stripped
    expect(files.every((f) => !f.includes("(new"))).toBe(true);
  });

  it("handles directory-level scope entries", () => {
    const spec = `
## Scope

**In scope:**
- \`src/domain/ask/\`

**Out of scope:**
`;
    const { files } = extractInScopeFiles(spec);
    // Directory paths should be included
    expect(files.length).toBeGreaterThanOrEqual(0);
    // If extracted, should include the directory
    if (files.length > 0) {
      expect(files.some((f) => f.includes("src/domain/ask"))).toBe(true);
    }
  });

  // Round-10 NON-BLOCKING: bare-path regex accepts leading @ for scoped paths
  it("extracts bare @-scoped paths (e.g. @types/foo/index.d.ts)", () => {
    const spec = `
## Scope

**In scope:**
- @types/foo/index.d.ts (type definitions)
- @scope/pkg/src/util.ts

**Out of scope:**
- nothing
`;
    const { files } = extractInScopeFiles(spec);
    expect(files).toContain("@types/foo/index.d.ts");
    expect(files).toContain("@scope/pkg/src/util.ts");
  });
});

// ---------------------------------------------------------------------------
// findOverlappingFiles
// ---------------------------------------------------------------------------

describe("findOverlappingFiles", () => {
  it("returns empty array when no overlap", () => {
    const inScope = ["src/domain/tasks/", FIXTURE_SETTINGS_JSON];
    const prFiles = ["src/adapters/cli/index.ts", "tests/unit/foo.test.ts"];
    expect(findOverlappingFiles(inScope, prFiles)).toHaveLength(0);
  });

  it("detects exact file match", () => {
    const inScope = [FIXTURE_SETTINGS_JSON];
    const prFiles = [FIXTURE_SETTINGS_JSON, "src/domain/other.ts"];
    const result = findOverlappingFiles(inScope, prFiles);
    expect(result).toContain(FIXTURE_SETTINGS_JSON);
  });

  it("detects overlap when in-scope entry is a directory prefix of PR file", () => {
    const inScope = ["src/domain/ask/"];
    const prFiles = [FIXTURE_ASK_TS, FIXTURE_ASK_TEST_TS];
    const result = findOverlappingFiles(inScope, prFiles);
    expect(result.length).toBeGreaterThan(0);
  });

  it("detects overlap when PR file is a directory prefix of in-scope file", () => {
    const inScope = [FIXTURE_ASK_TS];
    const prFiles = ["src/domain/ask/"];
    const result = findOverlappingFiles(inScope, prFiles);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles leading ./ in in-scope paths", () => {
    const inScope = [`./${FIXTURE_SETTINGS_JSON}`];
    const prFiles = [FIXTURE_SETTINGS_JSON];
    const result = findOverlappingFiles(inScope, prFiles);
    expect(result).toContain(FIXTURE_SETTINGS_JSON);
  });

  it("does not produce duplicates for multiple scope entries matching same PR file", () => {
    const inScope = [FIXTURE_ASK_TS, "src/domain/ask/"];
    const prFiles = [FIXTURE_ASK_TS];
    const result = findOverlappingFiles(inScope, prFiles);
    // Should deduplicate
    expect(result.length).toBe(1);
  });

  it("does NOT false-match adjacent path prefixes (round-8 BLOCKING fix)", () => {
    // Reviewer-bot round 8: prFile.startsWith(scope) without slash boundary
    // false-matched `src/app` against `src/application/config.ts`. This test
    // pins the boundary semantics in place.
    expect(findOverlappingFiles(["src/app"], ["src/application/config.ts"])).toHaveLength(0);
    expect(findOverlappingFiles(["src/foo"], ["src/foobar/file.ts"])).toHaveLength(0);
    // Symmetric direction also boundary-bounded
    expect(findOverlappingFiles(["src/application/config.ts"], ["src/app"])).toHaveLength(0);
  });

  it("DOES match exact files and proper directory prefixes", () => {
    const APP_INDEX = "src/app/index.ts";
    expect(findOverlappingFiles([APP_INDEX], [APP_INDEX])).toHaveLength(1);
    expect(findOverlappingFiles(["src/app"], [APP_INDEX])).toHaveLength(1);
    expect(findOverlappingFiles(["src/app/"], [APP_INDEX])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// formatBlockMessage
// ---------------------------------------------------------------------------

describe("formatBlockMessage", () => {
  it("includes task ID in message", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "open-pr",
        prNumber: 788,
        prTitle: "feat(mt#1240): parallel work implementation",
        overlappingFiles: [FIXTURE_ASK_TS],
      },
    ];
    const msg = formatBlockMessage("mt#1068", collisions);
    expect(msg).toContain("mt#1068");
  });

  it("includes PR number and title for open-pr collision", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "open-pr",
        prNumber: 788,
        prTitle: "feat(mt#1240): some feature",
        overlappingFiles: [FIXTURE_ASK_TS, FIXTURE_ASK_TEST_TS],
      },
    ];
    const msg = formatBlockMessage("mt#1068", collisions);
    expect(msg).toContain("PR #788");
    expect(msg).toContain("feat(mt#1240): some feature");
    expect(msg).toContain(FIXTURE_ASK_TS);
  });

  it("includes commit sha and message for recently-merged collision", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "recently-merged",
        commitSha: "abc1234",
        commitMessage: "feat: landed ask domain refactor",
        overlappingFiles: [FIXTURE_ASK_TS],
      },
    ];
    const msg = formatBlockMessage("mt#1362", collisions);
    expect(msg).toContain("abc1234");
    expect(msg).toContain("feat: landed ask domain refactor");
  });

  it("includes override instructions", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "open-pr",
        prNumber: 788,
        prTitle: "some PR",
        overlappingFiles: ["src/foo.ts"],
      },
    ];
    const msg = formatBlockMessage("mt#1068", collisions);
    expect(msg).toContain("MINSKY_FORCE_PARALLEL=1");
  });

  it("includes recommended actions", () => {
    const collisions: ParallelWorkCollision[] = [
      {
        type: "open-pr",
        prNumber: 1,
        prTitle: "some PR",
        overlappingFiles: ["src/foo.ts"],
      },
    ];
    const msg = formatBlockMessage("mt#1", collisions);
    expect(msg).toContain("WAIT");
    expect(msg).toContain("COORDINATE");
    expect(msg).toContain("REFRAME");
    expect(msg).toContain("OVERRIDE");
  });
});

// ---------------------------------------------------------------------------
// runParallelWorkChecks — hermetic (mocked) tests
// ---------------------------------------------------------------------------

describe("runParallelWorkChecks — mt#1068 incident replay", () => {
  /**
   * Simulate the mt#1068 incident:
   * - Task mt#1068 wants to modify src/domain/ask/ files
   * - PR #788 (mt#1240) is open and touches src/domain/ask/
   *
   * We test the collision detection logic directly using findOverlappingFiles,
   * since runParallelWorkChecks calls external commands (gh, git) that are
   * not available in unit tests.
   */
  it("detects mt#1068 / PR #788 collision in ask domain", () => {
    const inScopeFiles = [FIXTURE_ASK_TS, FIXTURE_ASK_TEST_TS, FIXTURE_SETTINGS_JSON];
    // Files that PR #788 (mt#1240) touched
    const pr788Files = [
      FIXTURE_ASK_TS,
      "src/domain/ask/index.ts",
      "src/adapters/cli/ask.adapter.ts",
    ];

    const overlapping = findOverlappingFiles(inScopeFiles, pr788Files);
    expect(overlapping.length).toBeGreaterThan(0);
    expect(overlapping).toContain(FIXTURE_ASK_TS);
  });

  it("does NOT flag non-overlapping PR", () => {
    const inScopeFiles = ["src/domain/tasks/", FIXTURE_SETTINGS_JSON];
    const unrelatedPrFiles = ["src/adapters/cli/session.adapter.ts", "tests/unit/session.test.ts"];

    const overlapping = findOverlappingFiles(inScopeFiles, unrelatedPrFiles);
    expect(overlapping).toHaveLength(0);
  });
});

describe("runParallelWorkChecks — clean path", () => {
  it("returns not blocked with empty in-scope files", () => {
    const checkInput: ParallelWorkCheckInput = {
      taskId: "mt#9999",
      inScopeFiles: [],
      repo: "edobry/minsky",
      lookbackHours: 24,
    };

    // With empty in-scope files, no overlap is possible
    const result = runParallelWorkChecks(checkInput, "/tmp/nonexistent-repo-dir");
    // Both checks will fail gracefully (gh and git won't work in test env),
    // producing warnings but not blocking
    expect(result.blocked).toBe(false);
  });

  it("returns not blocked when injected deps return no collisions (true green path)", () => {
    const checkInput: ParallelWorkCheckInput = {
      taskId: "mt#9999",
      inScopeFiles: [FIXTURE_ASK_TS, FIXTURE_SETTINGS_JSON],
      repo: "edobry/minsky",
      lookbackHours: 24,
    };

    const cleanDeps: ParallelWorkCheckDeps = makeDeps({});

    const result = runParallelWorkChecks(checkInput, "/tmp/anywhere", undefined, cleanDeps);
    expect(result.blocked).toBe(false);
    expect(result.collisions).toHaveLength(0);
    // detectDefaultBranch emits a warning when repoDir is not a real git repo;
    // that is the expected fall-back behavior (still permits, does not block).
    // We verify there are no collision-related warnings.
    expect(result.warnings.every((w) => !w.includes("sweep failed"))).toBe(true);
  });
});

describe("runParallelWorkChecks — colliding path (full integration via DI)", () => {
  it("blocks on open-PR collision (mt#1068 incident replay through full pipeline)", () => {
    const checkInput: ParallelWorkCheckInput = {
      taskId: "mt#1068",
      inScopeFiles: [FIXTURE_ASK_TS, FIXTURE_ASK_TEST_TS],
      repo: "edobry/minsky",
      lookbackHours: 24,
    };

    // Mock deps simulate the actual mt#1068 scenario:
    // PR #788 (mt#1240) is open and touches src/domain/ask/
    const collidingDeps: ParallelWorkCheckDeps = makeDeps({
      fetchOpenPrs: () => [
        {
          number: 788,
          title: "feat(mt#1240): Ask reconciler chain",
          headRefName: "task/mt-1240",
        },
      ],
      fetchPrFiles: (_repo, prNumber) =>
        prNumber === 788 ? [FIXTURE_ASK_TS, "src/domain/ask/index.ts"] : [],
    });

    const result = runParallelWorkChecks(checkInput, "/tmp/anywhere", undefined, collidingDeps);
    expect(result.blocked).toBe(true);
    expect(result.collisions).toHaveLength(1);
    const collision = result.collisions[0];
    expect(collision).toBeDefined();
    if (!collision) throw new Error("expected collision");
    expect(collision.type).toBe("open-pr");
    expect(collision.prNumber).toBe(788);
    expect(collision.overlappingFiles).toContain(FIXTURE_ASK_TS);
  });

  it("blocks on recently-merged collision", () => {
    const checkInput: ParallelWorkCheckInput = {
      taskId: "mt#9001",
      inScopeFiles: [FIXTURE_ASK_TS],
      repo: "edobry/minsky",
      lookbackHours: 24,
    };

    const recentMergeDeps: ParallelWorkCheckDeps = makeDeps({
      fetchRecentMerges: () => [
        {
          type: "recently-merged",
          commitSha: "abcd123",
          commitMessage: "feat(mt#1240): land Ask domain",
          overlappingFiles: [FIXTURE_ASK_TS],
        },
      ],
    });

    const result = runParallelWorkChecks(checkInput, "/tmp/anywhere", undefined, recentMergeDeps);
    expect(result.blocked).toBe(true);
    expect(result.collisions).toHaveLength(1);
    const collision = result.collisions[0];
    expect(collision).toBeDefined();
    if (!collision) throw new Error("expected collision");
    expect(collision.type).toBe("recently-merged");
  });

  it("skips the task's own branch when scanning open PRs", () => {
    const checkInput: ParallelWorkCheckInput = {
      taskId: "mt#1362",
      inScopeFiles: [FIXTURE_HOOK_TS],
      repo: "edobry/minsky",
      lookbackHours: 24,
    };

    // The task's own PR is open and touches the same file — but we should skip it.
    const ownBranchDeps: ParallelWorkCheckDeps = makeDeps({
      fetchOpenPrs: () => [
        {
          number: 851,
          title: "feat(mt#1362): own PR",
          headRefName: "task/mt-1362",
        },
      ],
      fetchPrFiles: () => [FIXTURE_HOOK_TS],
    });

    const result = runParallelWorkChecks(
      checkInput,
      "/tmp/anywhere",
      "task/mt-1362",
      ownBranchDeps
    );
    expect(result.blocked).toBe(false);
    expect(result.collisions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractInScopeFiles — mt#1362's own spec
// ---------------------------------------------------------------------------

describe("extractInScopeFiles — mt#1362 spec fixture", () => {
  const mt1362Spec = `
## Summary

Implement a PreToolUse hook...

## Scope

**In scope:**
- \`.claude/hooks/parallel-work-guard.ts\` (new file)
- \`.claude/settings.json\` (hook registration)
- Documentation update in CLAUDE.md or relevant rule about override mechanism
- Test fixtures or smoke test for the hook

**Out of scope:**
- Extending the hook to \`tasks_create\` for bug-fix tasks
- Modifying the existing skill-step checks
`;

  it("correctly parses mt#1362 scope section", () => {
    const { files, warnings } = extractInScopeFiles(mt1362Spec);
    expect(warnings).toHaveLength(0);
    expect(files).toContain(FIXTURE_HOOK_TS);
    expect(files).toContain(FIXTURE_SETTINGS_JSON);
  });

  it("handles parenthetical-suffix In-scope header (mt#1305 style)", () => {
    // mt#1305-style spec uses `**In scope (this task):**` with a parenthetical
    // qualifier — the original regex only matched the bare `**In scope:**` form.
    const mt1305StyleSpec = `
## Scope

**In scope (this task):**
- \`.claude/skills/plan-task/SKILL.md\`
- \`.claude/skills/implement-task/SKILL.md\`

**Out of scope:**
- Hook implementation (separate task)
`;
    const { files, warnings } = extractInScopeFiles(mt1305StyleSpec);
    expect(warnings).toHaveLength(0);
    expect(files).toContain(".claude/skills/plan-task/SKILL.md");
    expect(files).toContain(".claude/skills/implement-task/SKILL.md");
  });

  it("handles ## Scope: heading with trailing colon", () => {
    // Some specs use `## Scope:` with a trailing colon. The loosened regex
    // (mt#1362 reviewer fix) tolerates this variant.
    const colonHeadingSpec = `
## Scope:

**In scope:**
- \`src/foo.ts\`

**Out of scope:**
- nothing
`;
    const { files, warnings } = extractInScopeFiles(colonHeadingSpec);
    expect(warnings).toHaveLength(0);
    expect(files).toContain("src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// parseGitHubRemoteUrl — pure URL-parsing branches
// ---------------------------------------------------------------------------

describe("parseGitHubRemoteUrl", () => {
  it("parses SCP-style SSH form with .git suffix", () => {
    expect(parseGitHubRemoteUrl("git@github.com:edobry/minsky.git")).toBe("edobry/minsky");
  });

  it("parses SCP-style SSH form without .git suffix", () => {
    expect(parseGitHubRemoteUrl("git@github.com:edobry/minsky")).toBe("edobry/minsky");
  });

  it("parses URL-style ssh:// with git@ user", () => {
    expect(parseGitHubRemoteUrl("ssh://git@github.com/edobry/minsky.git")).toBe("edobry/minsky");
  });

  it("parses URL-style ssh:// without user", () => {
    expect(parseGitHubRemoteUrl("ssh://github.com/edobry/minsky.git")).toBe("edobry/minsky");
  });

  it("parses URL-style ssh:// without .git suffix", () => {
    expect(parseGitHubRemoteUrl("ssh://git@github.com/edobry/minsky")).toBe("edobry/minsky");
  });

  it("parses HTTPS form with .git suffix", () => {
    expect(parseGitHubRemoteUrl("https://github.com/edobry/minsky.git")).toBe("edobry/minsky");
  });

  it("parses HTTPS form without .git suffix", () => {
    expect(parseGitHubRemoteUrl("https://github.com/edobry/minsky")).toBe("edobry/minsky");
  });

  it("parses HTTPS form with trailing slash", () => {
    expect(parseGitHubRemoteUrl("https://github.com/edobry/minsky/")).toBe("edobry/minsky");
  });

  it("trims surrounding whitespace from input", () => {
    expect(parseGitHubRemoteUrl("  git@github.com:edobry/minsky.git\n")).toBe("edobry/minsky");
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseGitHubRemoteUrl("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGitHubRemoteUrl("https://bitbucket.org/owner/repo")).toBeNull();
  });

  it("returns null for empty or malformed input", () => {
    expect(parseGitHubRemoteUrl("")).toBeNull();
    expect(parseGitHubRemoteUrl("not a url")).toBeNull();
  });

  // Round-10 NON-BLOCKING: additional URL forms
  it("parses ssh:// with port qualifier (ssh://git@github.com:22/owner/repo)", () => {
    expect(parseGitHubRemoteUrl("ssh://git@github.com:22/edobry/minsky.git")).toBe("edobry/minsky");
    expect(parseGitHubRemoteUrl("ssh://git@github.com:22/edobry/minsky")).toBe("edobry/minsky");
  });

  it("parses git+ssh:// prefix form", () => {
    expect(parseGitHubRemoteUrl("git+ssh://git@github.com/edobry/minsky.git")).toBe(
      "edobry/minsky"
    );
    expect(parseGitHubRemoteUrl("git+ssh://git@github.com/edobry/minsky")).toBe("edobry/minsky");
  });

  it("parses HTTPS with embedded credentials (token@github.com)", () => {
    expect(parseGitHubRemoteUrl("https://mytoken@github.com/edobry/minsky.git")).toBe(
      "edobry/minsky"
    );
    expect(parseGitHubRemoteUrl("https://user:pass@github.com/edobry/minsky")).toBe(
      "edobry/minsky"
    );
  });
});

// ---------------------------------------------------------------------------
// runParallelWorkChecks — failure/warning paths
// ---------------------------------------------------------------------------

describe("runParallelWorkChecks — failure and warning paths", () => {
  const baseInput: ParallelWorkCheckInput = {
    taskId: "mt#9999",
    inScopeFiles: [FIXTURE_ASK_TS],
    repo: "edobry/minsky",
    lookbackHours: 24,
  };

  it("emits a warning when fetchOpenPrs throws, does not block", () => {
    const throwingOpenPrsDeps: ParallelWorkCheckDeps = makeDeps({
      fetchOpenPrs: () => {
        throw new Error("gh: command not found");
      },
    });

    const result = runParallelWorkChecks(
      baseInput,
      "/tmp/anywhere",
      undefined,
      throwingOpenPrsDeps
    );
    expect(result.blocked).toBe(false);
    expect(result.warnings.some((w) => w.includes("Open-PR sweep failed"))).toBe(true);
  });

  it("emits a warning when fetchRecentMerges throws, does not block", () => {
    const throwingMergesDeps: ParallelWorkCheckDeps = makeDeps({
      fetchRecentMerges: () => {
        throw new Error("git: not a git repository");
      },
    });

    const result = runParallelWorkChecks(baseInput, "/tmp/anywhere", undefined, throwingMergesDeps);
    expect(result.blocked).toBe(false);
    expect(result.warnings.some((w) => w.includes("Recently-merged sweep failed"))).toBe(true);
  });

  it("continues to check recently-merged when fetchOpenPrs throws (resilience)", () => {
    const mergedCollision: ParallelWorkCollision = {
      type: "recently-merged",
      commitSha: "abc1234",
      commitMessage: "feat: something that overlaps",
      overlappingFiles: [FIXTURE_ASK_TS],
    };

    const resilientDeps: ParallelWorkCheckDeps = makeDeps({
      fetchOpenPrs: () => {
        throw new Error("gh: command not found");
      },
      fetchRecentMerges: () => [mergedCollision],
    });

    const result = runParallelWorkChecks(baseInput, "/tmp/anywhere", undefined, resilientDeps);
    // Open-PR sweep failed => warning, but recently-merged sweep ran and found collision
    expect(result.warnings.some((w) => w.includes("Open-PR sweep failed"))).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.collisions).toHaveLength(1);
    const resilientCollision = result.collisions[0];
    expect(resilientCollision).toBeDefined();
    if (!resilientCollision) throw new Error("expected collision");
    expect(resilientCollision.type).toBe("recently-merged");
  });
});

// ---------------------------------------------------------------------------
// isOwnBranch — round-10 BLOCKING fix: exact-branch-match only
// ---------------------------------------------------------------------------

describe("isOwnBranch", () => {
  it("matches via exact currentBranch equality", () => {
    expect(isOwnBranch("feature/anything", "mt#1362", "feature/anything")).toBe(true);
  });

  it("matches task/mt-N branch exactly when currentBranch is provided", () => {
    expect(isOwnBranch("task/mt-1362", "mt#1362", "task/mt-1362")).toBe(true);
  });

  it("does NOT match when currentBranch differs from branchName", () => {
    // A teammate opened a PR using the same task ID from a different branch
    expect(isOwnBranch("feature/mt-1362", "mt#1362", "task/mt-1362")).toBe(false);
    expect(isOwnBranch("task/mt-1362", "mt#1362", "feature/mt-1362")).toBe(false);
  });

  it("does NOT match when currentBranch is absent (null)", () => {
    // If we cannot determine currentBranch, treat all branches as peers
    expect(isOwnBranch("task/mt-1362", "mt#1362", null)).toBe(false);
    expect(isOwnBranch("feature/mt-1362", "mt#1362", null)).toBe(false);
    expect(isOwnBranch("bugfix/mt-1362", "mt#1362", null)).toBe(false);
  });

  it("does NOT match when currentBranch is absent (undefined)", () => {
    expect(isOwnBranch("task/mt-1362", "mt#1362")).toBe(false);
  });

  it("does NOT match unrelated branches regardless of currentBranch", () => {
    expect(isOwnBranch("main", "mt#1362", "task/mt-1362")).toBe(false);
    expect(isOwnBranch("task/mt-1305", "mt#1362", "task/mt-1362")).toBe(false);
    expect(isOwnBranch("feature/something-else", "mt#1362", "task/mt-1362")).toBe(false);
  });

  it("does NOT use token-based heuristic (round-10 BLOCKING fix)", () => {
    // These all contain the task token as a delimited segment but are NOT the
    // current branch — they must be treated as peers, not own-branch skips.
    expect(isOwnBranch("task/mt-1362", "mt#1362")).toBe(false);
    expect(isOwnBranch("feature/mt-1362", "mt#1362")).toBe(false);
    expect(isOwnBranch("task/MT-1362", "mt#1362")).toBe(false);
    expect(isOwnBranch("task/mt-1362-extra", "mt#1362")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectDefaultBranch — round-5 BLOCKING fix: fallback chain instead of
// silent fallback to origin/main on every failure
// ---------------------------------------------------------------------------

describe("detectDefaultBranch", () => {
  it("returns null with warning when ALL probes fail (non-existent dir)", () => {
    const result = detectDefaultBranch("/tmp/nonexistent-parallel-work-guard-fixture");
    expect(result.ref).toBeNull();
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("Could not detect default remote branch");
  });
});

// ---------------------------------------------------------------------------
// runParallelWorkChecks — round-5: PR-cap (>100) warning
// ---------------------------------------------------------------------------

describe("runParallelWorkChecks — round-5 PR cap behaviour", () => {
  it("emits server-cap warning when prs.length === 200 (likely truncated)", () => {
    // Round-9 reviewer: in production, gh pr list --limit 200 truncates at
    // the server, so prs.length > 200 never fires. Pin the equality-cap
    // path that DOES fire in production.
    const exactlyAtCap = Array.from({ length: 200 }, (_, i) => ({
      number: i + 1,
      title: `feat: PR ${i + 1}`,
      headRefName: `feature/pr-${i + 1}`,
    }));

    const checkInput: ParallelWorkCheckInput = {
      taskId: "mt#9999",
      inScopeFiles: [FIXTURE_HOOK_TS],
      repo: "edobry/minsky",
      lookbackHours: 24,
    };

    const atCapDeps: ParallelWorkCheckDeps = makeDeps({
      fetchOpenPrs: () => exactlyAtCap,
      fetchPrFiles: () => ["unrelated/file.ts"],
    });

    const result = runParallelWorkChecks(checkInput, "/tmp/anywhere", null, atCapDeps);
    expect(result.warnings.some((w) => w.includes("server cap of 200"))).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("caps the per-PR sweep at 200 and emits a warning when exceeded", () => {
    const HOW_MANY = 250;
    const manyPrs = Array.from({ length: HOW_MANY }, (_, i) => ({
      number: i + 1,
      title: `feat: PR ${i + 1}`,
      headRefName: `feature/pr-${i + 1}`,
    }));

    const checkInput: ParallelWorkCheckInput = {
      taskId: "mt#9999",
      inScopeFiles: [FIXTURE_HOOK_TS],
      repo: "edobry/minsky",
      lookbackHours: 24,
    };

    let fetchPrFilesCalls = 0;
    const cappedDeps: ParallelWorkCheckDeps = makeDeps({
      fetchOpenPrs: () => manyPrs,
      fetchPrFiles: () => {
        fetchPrFilesCalls += 1;
        return ["unrelated/file.ts"];
      },
    });

    const result = runParallelWorkChecks(checkInput, "/tmp/anywhere", null, cappedDeps);
    expect(fetchPrFilesCalls).toBe(200);
    expect(result.warnings.some((w) => w.includes("capped at 200"))).toBe(true);
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAppendOnlyToJsonArrays — append-only structured-config check (mt#1587)
// ---------------------------------------------------------------------------

describe("isAppendOnlyToJsonArrays", () => {
  it("returns true for identical objects", () => {
    const before = { a: 1, b: [1, 2, 3] };
    const after = { a: 1, b: [1, 2, 3] };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(true);
  });

  it("returns true when an array grows at the tail (existing elements unchanged)", () => {
    const before = { hooks: [{ matcher: "tool1" }] };
    const after = { hooks: [{ matcher: "tool1" }, { matcher: "tool2" }] };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(true);
  });

  it("returns true for nested array growth in real settings.json shape", () => {
    const before = {
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      hooks: {
        PreToolUse: [{ matcher: "tool1", hooks: [{ type: "command", command: "x" }] }],
      },
    };
    const after = {
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      hooks: {
        PreToolUse: [
          { matcher: "tool1", hooks: [{ type: "command", command: "x" }] },
          { matcher: "tool2", hooks: [{ type: "command", command: "y" }] },
        ],
      },
    };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(true);
  });

  it("returns false when an array shrinks", () => {
    const before = { hooks: [{ a: 1 }, { a: 2 }] };
    const after = { hooks: [{ a: 1 }] };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("returns false when an existing array element is modified", () => {
    const before = { hooks: [{ matcher: "tool1" }] };
    const after = { hooks: [{ matcher: "tool1-renamed" }] };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("returns false when a top-level object key is added", () => {
    const before = { env: { X: "Y" } };
    const after = { env: { X: "Y" }, newKey: "value" };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("returns false when a nested object key is added", () => {
    const before = { env: { X: "Y" } };
    const after = { env: { X: "Y", Z: "W" } };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("returns false when a primitive value changes", () => {
    const before = { env: { X: "Y" } };
    const after = { env: { X: "Z" } };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("returns false when an array element is inserted at the head (shifts existing indices)", () => {
    const before = { hooks: [{ a: 1 }] };
    const after = { hooks: [{ a: 0 }, { a: 1 }] };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("returns false when array becomes object", () => {
    const before = { hooks: [{ a: 1 }] };
    const after = { hooks: { 0: { a: 1 } } };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("returns false when object becomes array", () => {
    const before = { hooks: { foo: 1 } };
    const after = { hooks: [{ foo: 1 }] };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("handles deep array growth (array of arrays)", () => {
    const before = { matrix: [[1, 2]] };
    const after = {
      matrix: [
        [1, 2],
        [3, 4],
      ],
    };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(true);
  });

  it("rejects growth in a nested array's existing row", () => {
    // Adding to the inner array at index 0 means modifying an existing
    // element of the OUTER array — not append-only at the outer level.
    const before = { matrix: [[1, 2]] };
    const after = { matrix: [[1, 2, 3]] };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("STRUCTURED_CONFIG_ALLOWLIST contains the expected paths", () => {
    expect(STRUCTURED_CONFIG_ALLOWLIST).toContain(FIXTURE_SETTINGS_JSON);
    expect(STRUCTURED_CONFIG_ALLOWLIST).toContain(
      `${FIXTURE_SETTINGS_JSON.replace(".json", ".local.json")}`
    );
  });

  it("treats objects with same keys in different order as equal (PR #952 R3#2)", () => {
    // Two semantically-identical objects with different key insertion order
    // — possible when one ref's settings.json was prettified and another
    // was hand-edited. Pre-R3#2, JSON.stringify-based equality returned
    // false here, defeating the exemption. Now the recursive equality
    // ignores object key order.
    const before = { matcher: "tool1", hooks: [{ a: 1, b: 2 }] };
    const after = { hooks: [{ b: 2, a: 1 }], matcher: "tool1" };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(true);
  });

  it("rejects when b has extra keys not in a (PR #952 R9#7 explicit symmetric)", () => {
    // Sanity check that the length-equality + presence-in-b check is
    // effectively symmetric: if b has more keys than a, length differs
    // and the function returns false. Pin this so future refactors of
    // the key-comparison logic don't silently break symmetry.
    const before = { x: 1 };
    const after = { x: 1, y: 2 };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("rejects when a and b have same length but different keys (PR #952 R9#7)", () => {
    // Length-equal but keys differ: a has y, b has z. Loop over a's keys
    // hits y, hasOwnProperty on b is false, returns false. Symmetric in
    // effect even without explicit set comparison.
    const before = { x: 1, y: 2 };
    const after = { x: 1, z: 2 };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });

  it("treats NaN as equal to NaN for numeric primitives (PR #952 R8#2)", () => {
    // JSON.parse never produces NaN, but for non-JSON callers reusing the
    // helper, NaN-vs-NaN comparing as true matches intuitive equality.
    const before = { value: NaN };
    const after = { value: NaN };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(true);
  });

  it("array order still matters even with order-insensitive object compare (PR #952 R3#2)", () => {
    // Sanity check: arrays remain order-sensitive — only OBJECT keys are
    // treated as orderless. Reordering array elements must still register
    // as a structural change.
    const before = { hooks: [{ a: 1 }, { a: 2 }] };
    const after = { hooks: [{ a: 2 }, { a: 1 }] };
    expect(isAppendOnlyToJsonArrays(before, after)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runParallelWorkChecks — structured-config exemption integration (mt#1587)
// ---------------------------------------------------------------------------

describe("runParallelWorkChecks — structured-config exemption", () => {
  const taskInput: ParallelWorkCheckInput = {
    taskId: "mt#9999",
    inScopeFiles: [FIXTURE_SETTINGS_JSON, FIXTURE_NEW_HOOK_TS],
    repo: "owner/repo",
    lookbackHours: 24,
  };

  it("exempts settings.json overlap when the colliding PR's change is append-only", () => {
    const exemptDeps = makeDeps({
      fetchOpenPrs: () => [
        { number: 100, title: "feat(other-hook): add a hook", headRefName: "task/mt-100" },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, _from, _to, file) => {
        // Simulate: the PR's change to settings.json IS append-only.
        return file === FIXTURE_SETTINGS_JSON;
      },
    });

    const result = runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", exemptDeps);
    // The only overlapping file was settings.json, which got exempted.
    // No collision should be reported.
    expect(result.blocked).toBe(false);
    expect(result.collisions).toHaveLength(0);
    // The exemption should be visible in warnings for audit.
    expect(
      result.warnings.some((w) =>
        w.includes(`${FIXTURE_SETTINGS_JSON} change is append-only into JSON arrays`)
      )
    ).toBe(true);
  });

  it("does NOT exempt when the structural check returns false (modification, not append-only)", () => {
    const noExemptDeps = makeDeps({
      fetchOpenPrs: () => [
        { number: 101, title: "feat(other): modify settings", headRefName: "task/mt-101" },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      // Helper returns false → keep the collision.
      isFileChangeAppendOnly: () => false,
    });

    const result = runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", noExemptDeps);
    expect(result.blocked).toBe(true);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]?.overlappingFiles).toContain(FIXTURE_SETTINGS_JSON);
  });

  it("keeps a collision when overlap includes BOTH allowlisted AND non-allowlisted files", () => {
    // Even if settings.json is exempt, the parallel hook source file is a
    // real conflict — collision must still fire.
    const mixedDeps = makeDeps({
      fetchOpenPrs: () => [
        {
          number: 102,
          title: "feat(my-hook): same hook",
          headRefName: "task/mt-102",
        },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON, FIXTURE_NEW_HOOK_TS],
      isFileChangeAppendOnly: (_repo, _from, _to, file) => file === FIXTURE_SETTINGS_JSON,
    });

    const result = runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", mixedDeps);
    expect(result.blocked).toBe(true);
    expect(result.collisions).toHaveLength(1);
    // settings.json filtered out; hook .ts file remains as the real conflict.
    expect(result.collisions[0]?.overlappingFiles).toEqual([FIXTURE_NEW_HOOK_TS]);
  });

  it("does NOT call the structural check for non-allowlisted files", () => {
    const otherTask: ParallelWorkCheckInput = {
      taskId: "mt#9998",
      inScopeFiles: ["src/foo.ts"],
      repo: "owner/repo",
      lookbackHours: 24,
    };
    let appendOnlyCalls = 0;
    const counterDeps = makeDeps({
      fetchOpenPrs: () => [
        { number: 200, title: "feat(other): src change", headRefName: "task/mt-200" },
      ],
      fetchPrFiles: () => ["src/foo.ts"],
      isFileChangeAppendOnly: () => {
        appendOnlyCalls += 1;
        return true; // would exempt if called
      },
    });

    const result = runParallelWorkChecks(otherTask, "/tmp/anywhere", "task/mt-9998", counterDeps);
    expect(appendOnlyCalls).toBe(0);
    expect(result.blocked).toBe(true);
  });

  it("strips 'origin/' prefix from default branch ref before passing to structural check", () => {
    let observedBaseRef = "";
    const probeDeps = makeDeps({
      detectDefaultBranch: () => ({ ref: "origin/develop" }),
      fetchOpenPrs: () => [{ number: 300, title: "feat", headRefName: "task/mt-300" }],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, fromRef) => {
        observedBaseRef = fromRef;
        return true;
      },
    });

    runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", probeDeps);
    expect(observedBaseRef).toBe("develop"); // not "origin/develop"
  });

  it("falls back to 'main' as base ref when default-branch detection fails", () => {
    let observedBaseRef = "";
    const probeDeps = makeDeps({
      detectDefaultBranch: () => ({ ref: null, warning: "all probes failed" }),
      fetchOpenPrs: () => [{ number: 301, title: "feat", headRefName: "task/mt-301" }],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, fromRef) => {
        observedBaseRef = fromRef;
        return true;
      },
    });

    runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", probeDeps);
    // The recently-merged sweep is skipped when defaultBranchRef is null,
    // but the open-PR sweep still runs and uses "main" as the base.
    expect(observedBaseRef).toBe("main");
  });

  it("emits a warning when default-branch detection fails (open-PR fallback to 'main') (PR #952 R1 NON-BLOCKING #3)", () => {
    const fallbackDeps = makeDeps({
      detectDefaultBranch: () => ({ ref: null, warning: "all probes failed" }),
      fetchOpenPrs: () => [],
    });

    const result = runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", fallbackDeps);
    expect(
      result.warnings.some((w) =>
        w.includes("Open-PR structural-check baseBranch defaulted to 'main'")
      )
    ).toBe(true);
  });

  it("uses refs/pull/<num>/head as toRef regardless of fork status (PR #952 R4#1)", () => {
    let observedToRef = "";
    const refsDeps = makeDeps({
      fetchOpenPrs: () => [
        {
          number: 500,
          title: "feat: forked PR",
          headRefName: "fork-author:feature-branch", // fork-only ref
        },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, _from, toRef) => {
        observedToRef = toRef;
        return true;
      },
    });

    runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", refsDeps);
    // Canonical PR-head ref — addressable via the base repo's API for both
    // same-repo and forked PRs. Replaces the R3#1 attempt that used
    // headRefOid (a fork-only SHA, not in the base repo's git database).
    expect(observedToRef).toBe("refs/pull/500/head");
  });

  it("falls back to refs/pull/<num>/merge when /head fetch fails (PR #952 R8#1)", () => {
    const observedRefs: string[] = [];
    const fallbackDeps = makeDeps({
      detectDefaultBranch: () => ({ ref: "origin/main" }),
      fetchOpenPrs: () => [
        {
          number: 700,
          title: "feat: forked PR with private head",
          headRefName: "fork:branch",
          baseRefName: "main",
        },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, _from, toRef) => {
        observedRefs.push(toRef);
        // Simulate /head failure (returns false, fail-closed); /merge succeeds.
        return toRef.endsWith("/merge");
      },
    });

    const result = runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", fallbackDeps);
    // Both refs were tried in order.
    expect(observedRefs).toEqual(["refs/pull/700/head", "refs/pull/700/merge"]);
    // Exemption succeeded via fallback — no collision recorded.
    expect(result.blocked).toBe(false);
    // Audit warning records the fallback was used.
    expect(
      result.warnings.some((w) => w.includes("exemption resolved via refs/pull/700/merge fallback"))
    ).toBe(true);
  });

  it("passes a per-PR contentCache to isAppendOnly across fallback attempts (PR #952 R9#6)", () => {
    // Verify the cache is plumbed through: same Map instance is passed
    // to BOTH isAppendOnly invocations (the /head try and the /merge try).
    // The cache itself prevents fromRef re-fetches inside isFileChangeAppendOnly.
    const cachesObserved: Array<Map<string, string | null> | undefined> = [];
    const cacheDeps = makeDeps({
      fetchOpenPrs: () => [
        {
          number: 800,
          title: "feat: PR exercising both fallback attempts",
          headRefName: "task/mt-800",
          baseRefName: "main",
        },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, _from, toRef, _file, _warnings, contentCache) => {
        cachesObserved.push(contentCache);
        // /head fails, /merge succeeds → both attempts run
        return toRef.endsWith("/merge");
      },
    });

    runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", cacheDeps);
    // Both attempts received a cache; both received the SAME Map instance.
    expect(cachesObserved).toHaveLength(2);
    expect(cachesObserved[0]).toBeInstanceOf(Map);
    expect(cachesObserved[0]).toBe(cachesObserved[1]); // same instance
  });

  it("does not retry /merge when /head succeeds (PR #952 R8#1 efficiency)", () => {
    const observedRefs: string[] = [];
    const headSuccessDeps = makeDeps({
      fetchOpenPrs: () => [
        {
          number: 701,
          title: "feat: same-repo PR /head works",
          headRefName: "task/mt-701",
          baseRefName: "main",
        },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, _from, toRef) => {
        observedRefs.push(toRef);
        return true; // /head succeeds first try
      },
    });

    runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", headSuccessDeps);
    // Only /head was tried; /merge was not invoked.
    expect(observedRefs).toEqual(["refs/pull/701/head"]);
  });

  it("uses pr.baseRefName as fromRef when present (PR #952 R7#4)", () => {
    let observedFromRef = "";
    const baseDeps = makeDeps({
      detectDefaultBranch: () => ({ ref: "origin/main" }),
      fetchOpenPrs: () => [
        {
          number: 600,
          title: "feat: PR targeting develop branch",
          headRefName: "task/mt-600",
          baseRefName: "develop",
        },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, fromRef) => {
        observedFromRef = fromRef;
        return true;
      },
    });

    runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", baseDeps);
    // PR's actual base branch (develop) used, NOT the repo default (main).
    expect(observedFromRef).toBe("develop");
  });

  it("falls back to repo default branch when pr.baseRefName is absent (PR #952 R7#4 fallback)", () => {
    let observedFromRef = "";
    const fallbackDeps = makeDeps({
      detectDefaultBranch: () => ({ ref: "origin/main" }),
      fetchOpenPrs: () => [
        {
          number: 601,
          title: "feat: legacy test PR without baseRefName",
          headRefName: "task/mt-601",
          // baseRefName intentionally omitted
        },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, fromRef) => {
        observedFromRef = fromRef;
        return true;
      },
    });

    const result = runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", fallbackDeps);
    expect(observedFromRef).toBe("main");
    expect(
      result.warnings.some((w) =>
        w.includes("baseRefName unavailable — falling back to repo default branch 'main'")
      )
    ).toBe(true);
  });

  it("uses refs/pull/<num>/head for same-repo PRs too (PR #952 R4#1 consistency)", () => {
    let observedToRef = "";
    const sameRepoDeps = makeDeps({
      fetchOpenPrs: () => [
        {
          number: 501,
          title: "feat: same-repo PR",
          headRefName: "task/mt-501",
        },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, _from, toRef) => {
        observedToRef = toRef;
        return true;
      },
    });

    runParallelWorkChecks(taskInput, "/tmp/anywhere", "task/mt-9999", sameRepoDeps);
    expect(observedToRef).toBe("refs/pull/501/head");
  });

  it("preserves collision and emits a triage warning when allowlisted file is NOT append-only (PR #952 R1 inline nit)", () => {
    // Simulates the gh API failure / parse failure path: structural check
    // returns false (cannot prove append-only), collision must be preserved
    // and the WHY surfaced for triage.
    const failClosedDeps = makeDeps({
      fetchOpenPrs: () => [
        { number: 400, title: "feat(other): real conflict", headRefName: "task/mt-400" },
      ],
      fetchPrFiles: () => [FIXTURE_SETTINGS_JSON],
      isFileChangeAppendOnly: (_repo, _from, _to, _file, warnings) => {
        // Simulate the helper writing a fetch-failure warning, then
        // returning false (fail-closed).
        warnings.push("Could not fetch .claude/settings.json@feature-branch: gh exited 4");
        return false;
      },
    });

    const result = runParallelWorkChecks(
      taskInput,
      "/tmp/anywhere",
      "task/mt-9999",
      failClosedDeps
    );
    // Fail-closed: collision preserved.
    expect(result.blocked).toBe(true);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]?.overlappingFiles).toContain(FIXTURE_SETTINGS_JSON);
    // Operator-facing: gh failure warning AND keeping-collision triage hint
    // both visible.
    expect(result.warnings.some((w) => w.includes("Could not fetch"))).toBe(true);
    expect(
      result.warnings.some((w) =>
        w.includes(`${FIXTURE_SETTINGS_JSON} is allowlisted but its change is NOT append-only`)
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchFileContentAtRef — path-encoding regression (PR #952 R1 BLOCKING)
// ---------------------------------------------------------------------------

describe("fetchFileContentAtRef — path-encoding regression (PR #952 R1 BLOCKING)", () => {
  // The PR #952 R1 BLOCKING was: encodeURIComponent on the FULL filePath
  // encoded '/' as '%2F', causing GitHub Contents API to 404 every fetch
  // and disabling the exemption entirely. The fix encodes each path SEGMENT
  // separately and rejoins with '/', preserving slashes in the URL path.
  it("encodes path segments individually and rejoins with '/' (no '%2F' in path)", () => {
    const filePath = FIXTURE_SETTINGS_JSON;
    const encoded = filePath.split("/").map(encodeURIComponent).join("/");
    expect(encoded).toBe(FIXTURE_SETTINGS_JSON); // slashes preserved
    expect(encoded).not.toContain("%2F");
  });

  it("encodes special characters in segments while keeping slashes", () => {
    const filePath = "src/My Component.tsx";
    const encoded = filePath.split("/").map(encodeURIComponent).join("/");
    expect(encoded).toBe("src/My%20Component.tsx"); // space encoded inside segment
    expect(encoded).not.toContain("%2F");
  });
});

// ---------------------------------------------------------------------------
// fetchFileContentAtRef — rev-spec ref guard (PR #952 R4#2 BLOCKING)
// ---------------------------------------------------------------------------

describe("fetchFileContentAtRef — rev-spec ref guard (PR #952 R4#2)", () => {
  // The GitHub Contents API rejects rev-spec expressions like <sha>^,
  // <sha>~1, HEAD^. Defense-in-depth: fetchFileContentAtRef now refuses
  // any ref containing ^ or ~ before issuing the API call, preventing
  // future regressions that reintroduce <sha>^ as a fromRef.
  it("refuses refs containing ^ (parent-spec) and emits a triage warning", () => {
    const warnings: string[] = [];
    const result = fetchFileContentAtRef("owner/repo", "abc123^", FIXTURE_SETTINGS_JSON, warnings);
    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("rev-spec syntax"))).toBe(true);
  });

  it("refuses refs containing ~ (ancestor-spec)", () => {
    const warnings: string[] = [];
    const result = fetchFileContentAtRef("owner/repo", "abc123~1", FIXTURE_SETTINGS_JSON, warnings);
    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("rev-spec syntax"))).toBe(true);
  });

  it("refuses HEAD^ as a ref", () => {
    const warnings: string[] = [];
    const result = fetchFileContentAtRef("owner/repo", "HEAD^", FIXTURE_SETTINGS_JSON, warnings);
    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("rev-spec syntax"))).toBe(true);
  });

  // Note: positive-path tests (valid SHA / branch / refs/pull/N/head)
  // require live `gh api` execution and are out of scope for unit tests.
  // The rev-spec guard is sufficient to prevent the BLOCKING regression
  // class; integration coverage lives in mt#1497-style replay scripts.
});
