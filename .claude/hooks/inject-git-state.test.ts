#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import {
  buildGitStateSnapshot,
  formatGitState,
  GIT_STATE_INJECTION_OVERRIDE_ENV,
  parsePorcelainStatus,
  type GitStateSnapshot,
} from "./inject-git-state";

// Shared snapshot fixture — extended per-test to exercise variations.
const BASE_SNAP: GitStateSnapshot = {
  branch: "main",
  aheadMain: 0,
  behindMain: 0,
  modified: 0,
  untracked: 0,
  staged: 0,
  recentCommits: [],
  defaultBranch: "main",
};

describe("formatGitState (mt#2275)", () => {
  it("collapses to a single line when clean and in sync with default branch", () => {
    const out = formatGitState(BASE_SNAP);
    expect(out).toBe("Current git state: on main, clean, in sync with last-fetched origin/main.");
  });

  it("uses the multi-line form when working tree is dirty", () => {
    const out = formatGitState({ ...BASE_SNAP, modified: 2, untracked: 1 });
    expect(out).toContain("Current git state:");
    expect(out).toContain("- Branch: main");
    expect(out).toContain("- Working tree: 2 modified, 1 untracked");
  });

  it("labels ahead/behind as vs last-fetched origin (no per-turn fetch)", () => {
    const out = formatGitState({
      ...BASE_SNAP,
      branch: "task/mt-2275",
      aheadMain: 3,
      behindMain: 0,
    });
    expect(out).toContain(
      "- Branch: task/mt-2275 (vs last-fetched origin/main: 3 ahead, 0 behind)"
    );
    expect(out).toContain("- Working tree: clean");
  });

  it("renders behind correctly when local lags origin", () => {
    const out = formatGitState({
      ...BASE_SNAP,
      branch: "task/mt-2275",
      aheadMain: 0,
      behindMain: 5,
    });
    expect(out).toContain(
      "- Branch: task/mt-2275 (vs last-fetched origin/main: 0 ahead, 5 behind)"
    );
  });

  it("surfaces an explicit note when default branch is undetectable (no silent assume-in-sync)", () => {
    const out = formatGitState({
      ...BASE_SNAP,
      branch: "feature/x",
      aheadMain: null,
      behindMain: null,
      defaultBranch: null,
      modified: 1,
    });
    expect(out).toContain("- Branch: feature/x (default branch undetectable");
    expect(out).toContain("ahead/behind omitted");
  });

  it("surfaces an explicit note when origin/default not available locally (e.g., not fetched yet)", () => {
    const out = formatGitState({
      ...BASE_SNAP,
      branch: "feature/x",
      aheadMain: null,
      behindMain: null,
      defaultBranch: "main",
    });
    expect(out).toContain("- Branch: feature/x (origin/main not available locally");
    expect(out).toContain("ahead/behind unknown");
  });

  it("never collapses when defaultBranch is null (no in-sync claim possible)", () => {
    const out = formatGitState({
      ...BASE_SNAP,
      defaultBranch: null,
      aheadMain: null,
      behindMain: null,
    });
    expect(out).toContain("\n");
    expect(out).toContain("- Working tree: clean");
  });

  it("lists recent commits when present", () => {
    const out = formatGitState({
      ...BASE_SNAP,
      branch: "task/mt-2275",
      aheadMain: 2,
      recentCommits: ["abc1234 feat(mt#2275): add hook", "def5678 fix(mt#2275): R1 review"],
    });
    expect(out).toContain("- Recent commits on branch:");
    expect(out).toContain("  abc1234 feat(mt#2275): add hook");
    expect(out).toContain("  def5678 fix(mt#2275): R1 review");
  });

  it("omits the recent-commits section when the list is empty", () => {
    const out = formatGitState({ ...BASE_SNAP, modified: 1, recentCommits: [] });
    expect(out).not.toContain("Recent commits");
  });

  it("renders 'staged' separately from 'modified' in the working-tree line", () => {
    const out = formatGitState({ ...BASE_SNAP, modified: 2, staged: 1 });
    expect(out).toContain("- Working tree: 2 modified, 1 staged");
  });
});

describe("parsePorcelainStatus (mt#2275)", () => {
  it("counts untracked files (?? prefix)", () => {
    const result = parsePorcelainStatus("?? new1.ts\n?? new2.ts\n");
    expect(result).toEqual({ modified: 0, untracked: 2, staged: 0 });
  });

  it("counts staged-only files (index column non-space, worktree column space)", () => {
    const result = parsePorcelainStatus("M  staged.ts\nA  added.ts\n");
    expect(result).toEqual({ modified: 0, untracked: 0, staged: 2 });
  });

  it("counts worktree-modified files (index space, worktree column non-space)", () => {
    const result = parsePorcelainStatus(" M edited.ts\n D deleted.ts\n");
    expect(result).toEqual({ modified: 2, untracked: 0, staged: 0 });
  });

  it("counts a file in both columns as both modified and staged", () => {
    // "MM file.ts" — staged change plus further unstaged change to the same file
    const result = parsePorcelainStatus("MM file.ts\n");
    expect(result).toEqual({ modified: 1, untracked: 0, staged: 1 });
  });

  it("returns zeros for empty input", () => {
    expect(parsePorcelainStatus("")).toEqual({ modified: 0, untracked: 0, staged: 0 });
  });

  it("ignores lines shorter than 2 characters", () => {
    const result = parsePorcelainStatus("\n \nM\nM  ok.ts\n");
    expect(result).toEqual({ modified: 0, untracked: 0, staged: 1 });
  });
});

describe("buildGitStateSnapshot (mt#2275)", () => {
  it("returns null for a non-git directory", () => {
    // /tmp is virtually never a git repo; if it is on a developer machine,
    // the test will surface that as an actual signal (the hook would fire
    // unexpectedly on /tmp invocations from a dev box where /tmp is git-init'd).
    expect(buildGitStateSnapshot("/tmp")).toBeNull();
  });

  // Note: a live smoke test against the session workspace was intentionally
  // omitted to satisfy custom/no-real-fs-in-tests. End-to-end execution was
  // verified manually via direct hook invocation; the pure functions
  // (formatGitState, parsePorcelainStatus) carry the logic coverage.
});

describe("GIT_STATE_INJECTION_OVERRIDE_ENV (mt#2275)", () => {
  it("is the documented MINSKY_SKIP_GIT_STATE_INJECTION env var", () => {
    expect(GIT_STATE_INJECTION_OVERRIDE_ENV).toBe("MINSKY_SKIP_GIT_STATE_INJECTION");
  });
});
