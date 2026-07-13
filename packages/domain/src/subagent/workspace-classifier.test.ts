/**
 * Workspace classifier tests (mt#1737)
 *
 * Uses temp directories to simulate real workspace states. Each test creates
 * a temp dir, optionally initialises a git repo and commits, and verifies that
 * classifyWorkspaceOutcome returns the expected outcome class.
 *
 * The GitHub PR query is exercised via the `ghRunner` DI option (see
 * `ClassifierOptions` in `workspace-classifier.ts`). `Bun.spawnSync` is not
 * mockable at the global level — its property descriptor is non-writable —
 * so DI is the correct seam.
 */

/* eslint-disable custom/no-real-fs-in-tests -- workspace-classifier inspects real fs/git state; tests use temp dirs */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdirSync as mkdirp, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import {
  classifyWorkspaceOutcome,
  type SubprocessResult,
  type WorkspaceClassification,
} from "./workspace-classifier";
import type { SubagentInvocationOutcome } from "../storage/schemas/subagent-invocations-schema";

// Local outcome constants — avoid magic-string duplication across assertions
// (the lint rule `custom/no-magic-string-duplication` fires on repeated literals).
const CRASHED: SubagentInvocationOutcome = "crashed-no-output";
const COMMITTED_NO_PR: SubagentInvocationOutcome = "committed-no-pr";
const PARTIAL_UNCOMMITTED: SubagentInvocationOutcome = "partial-uncommitted-no-handoff";
const PARTIAL_COMMITTED_HANDOFF: SubagentInvocationOutcome = "partial-committed-handoff-written";
const COMPLETED_WITH_PR: SubagentInvocationOutcome = "completed-with-pr";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and return its path. */
function makeTempDir(prefix = "ws-classifier-test-"): string {
  const dir = join(
    process.env["TMPDIR"] ?? "/tmp",
    `${prefix}${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a temp directory created by makeTempDir. */
function cleanTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Initialise a git repo in `dir` with an initial commit.
 * Configures local user.name / user.email so the commit doesn't require
 * a global git config.
 */
function gitInit(dir: string, withCommit = true): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  if (withCommit) {
    writeFileSync(join(dir, "README.md"), "initial");
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "initial"', { cwd: dir, stdio: "pipe" });
  }
}

/** Stage an uncommitted file in `dir`. */
function addUncommittedFile(dir: string, filename = "dirty.txt"): void {
  writeFileSync(join(dir, filename), "dirty content");
}

// ---------------------------------------------------------------------------
// Fake gh runner factory
// ---------------------------------------------------------------------------

/**
 * Build a gh runner that returns a canned JSON output, simulating
 * `gh pr list --json url` behavior. `output` is the JSON string returned on
 * stdout; pass `null` to simulate a gh failure (exit code 1).
 */
function makeGhRunner(output: string | null): (args: string[]) => SubprocessResult {
  return (_args: string[]): SubprocessResult => {
    if (output === null) {
      return { exitCode: 1, stdout: "", stderr: "gh: command not found" };
    }
    return { exitCode: 0, stdout: output, stderr: "" };
  };
}

/** A gh runner that returns "no PRs found" (the default test state). */
const ghRunnerNoPr = makeGhRunner("[]");

/** A gh runner that returns one PR with the given URL. */
function ghRunnerWithPr(url: string): (args: string[]) => SubprocessResult {
  return makeGhRunner(JSON.stringify([{ url }]));
}

// ---------------------------------------------------------------------------
// Test wrapper — always passes ghRunner; gitRunner uses the real default
// ---------------------------------------------------------------------------

async function classify(
  workspace: string,
  taskId = "mt#1737",
  ghRunner: (args: string[]) => SubprocessResult = ghRunnerNoPr
): Promise<WorkspaceClassification> {
  return classifyWorkspaceOutcome(workspace, taskId, { ghRunner });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifyWorkspaceOutcome", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanTempDir(tmpDir);
  });

  test("missing workspace → crashed-no-output", async () => {
    const result = await classify("/does/not/exist/abc123");
    expect(result.outcome).toBe(CRASHED);
    expect(result.handoffWritten).toBe(false);
  });

  test("workspace with no git repo → crashed-no-output", async () => {
    // tmpDir exists but has no git repo
    const result = await classify(tmpDir);
    expect(result.outcome).toBe(CRASHED);
  });

  test("git repo with no commits → crashed-no-output", async () => {
    gitInit(tmpDir, false); // init without commit
    const result = await classify(tmpDir);
    expect(result.outcome).toBe(CRASHED);
  });

  test("clean workspace + commits + no PR → committed-no-pr", async () => {
    gitInit(tmpDir, true); // init with commit
    // No uncommitted changes, no PR (ghRunnerNoPr)
    const result = await classify(tmpDir);
    expect(result.outcome).toBe(COMMITTED_NO_PR);
    expect(result.lastCommitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.handoffWritten).toBe(false);
  });

  test("clean workspace + commits + no PR + handoff.md at root → committed-no-pr (handoffWritten=true)", async () => {
    gitInit(tmpDir, true);
    writeFileSync(join(tmpDir, "handoff.md"), "handoff content");
    // Commit the handoff so the workspace is genuinely clean — an uncommitted
    // handoff.md would correctly flip the classification to
    // `partial-committed-handoff-written` (it's a dirty file in `git status`).
    execSync("git add handoff.md", { cwd: tmpDir, stdio: "pipe" });
    execSync('git commit -m "add handoff"', { cwd: tmpDir, stdio: "pipe" });
    const result = await classify(tmpDir);
    expect(result.outcome).toBe(COMMITTED_NO_PR); // clean workspace + handoff present
    expect(result.handoffWritten).toBe(true);
  });

  test("uncommitted changes + no handoff.md → partial-uncommitted-no-handoff", async () => {
    gitInit(tmpDir, true);
    addUncommittedFile(tmpDir);
    const result = await classify(tmpDir);
    expect(result.outcome).toBe(PARTIAL_UNCOMMITTED);
    expect(result.handoffWritten).toBe(false);
  });

  test("uncommitted changes + handoff.md at root → partial-committed-handoff-written", async () => {
    gitInit(tmpDir, true);
    addUncommittedFile(tmpDir);
    writeFileSync(join(tmpDir, "handoff.md"), "handoff content");
    const result = await classify(tmpDir);
    expect(result.outcome).toBe(PARTIAL_COMMITTED_HANDOFF);
    expect(result.handoffWritten).toBe(true);
  });

  test("uncommitted changes + handoff.md at alternate path → partial-committed-handoff-written", async () => {
    gitInit(tmpDir, true);
    addUncommittedFile(tmpDir);
    const altDir = join(tmpDir, ".minsky", "sessions", "mt#1737");
    mkdirp(altDir, { recursive: true });
    writeFileSync(join(altDir, "handoff.md"), "handoff content");
    const result = await classify(tmpDir, "mt#1737");
    expect(result.outcome).toBe(PARTIAL_COMMITTED_HANDOFF);
    expect(result.handoffWritten).toBe(true);
  });

  test("PR exists for task → completed-with-pr", async () => {
    gitInit(tmpDir, true);
    const result = await classify(
      tmpDir,
      "mt#1737",
      ghRunnerWithPr("https://github.com/owner/repo/pull/42")
    );
    expect(result.outcome).toBe(COMPLETED_WITH_PR);
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/42");
  });

  test("gh failure → fails open, classification falls through", async () => {
    gitInit(tmpDir, true);
    const result = await classify(tmpDir, "mt#1737", makeGhRunner(null));
    // Should fall through to committed-no-pr (clean workspace, no PR found)
    expect(result.outcome).toBe(COMMITTED_NO_PR);
  });
});
