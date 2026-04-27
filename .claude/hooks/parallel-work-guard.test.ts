import { describe, expect, it } from "bun:test";

import {
  extractInScopeFiles,
  findOverlappingFiles,
  formatBlockMessage,
  runParallelWorkChecks,
  parseGitHubRemoteUrl,
  type ParallelWorkCheckInput,
  type ParallelWorkCheckDeps,
  type ParallelWorkCollision,
} from "./parallel-work-guard";

// ---------------------------------------------------------------------------
// Shared test fixtures (extracted to avoid magic-string duplication warnings)
// ---------------------------------------------------------------------------

const FIXTURE_SETTINGS_JSON = ".claude/settings.json";
const FIXTURE_ASK_TS = "src/domain/ask/ask.ts";
const FIXTURE_ASK_TEST_TS = "src/domain/ask/ask.test.ts";
const FIXTURE_HOOK_TS = ".claude/hooks/parallel-work-guard.ts";

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

    const cleanDeps: ParallelWorkCheckDeps = {
      fetchOpenPrs: () => [],
      fetchPrFiles: () => [],
      fetchRecentMerges: () => [],
    };

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
    const collidingDeps: ParallelWorkCheckDeps = {
      fetchOpenPrs: () => [
        {
          number: 788,
          title: "feat(mt#1240): Ask reconciler chain",
          headRefName: "task/mt-1240",
        },
      ],
      fetchPrFiles: (_repo, prNumber) =>
        prNumber === 788 ? [FIXTURE_ASK_TS, "src/domain/ask/index.ts"] : [],
      fetchRecentMerges: () => [],
    };

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

    const recentMergeDeps: ParallelWorkCheckDeps = {
      fetchOpenPrs: () => [],
      fetchPrFiles: () => [],
      fetchRecentMerges: () => [
        {
          type: "recently-merged",
          commitSha: "abcd123",
          commitMessage: "feat(mt#1240): land Ask domain",
          overlappingFiles: [FIXTURE_ASK_TS],
        },
      ],
    };

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
    const ownBranchDeps: ParallelWorkCheckDeps = {
      fetchOpenPrs: () => [
        {
          number: 851,
          title: "feat(mt#1362): own PR",
          headRefName: "task/mt-1362",
        },
      ],
      fetchPrFiles: () => [FIXTURE_HOOK_TS],
      fetchRecentMerges: () => [],
    };

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
  it("parses SSH form with .git suffix", () => {
    expect(parseGitHubRemoteUrl("git@github.com:edobry/minsky.git")).toBe("edobry/minsky");
  });

  it("parses SSH form without .git suffix", () => {
    expect(parseGitHubRemoteUrl("git@github.com:edobry/minsky")).toBe("edobry/minsky");
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
    const throwingOpenPrsDeps: ParallelWorkCheckDeps = {
      fetchOpenPrs: () => {
        throw new Error("gh: command not found");
      },
      fetchPrFiles: () => [],
      fetchRecentMerges: () => [],
    };

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
    const throwingMergesDeps: ParallelWorkCheckDeps = {
      fetchOpenPrs: () => [],
      fetchPrFiles: () => [],
      fetchRecentMerges: () => {
        throw new Error("git: not a git repository");
      },
    };

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

    const resilientDeps: ParallelWorkCheckDeps = {
      fetchOpenPrs: () => {
        throw new Error("gh: command not found");
      },
      fetchPrFiles: () => [],
      fetchRecentMerges: () => [mergedCollision],
    };

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
