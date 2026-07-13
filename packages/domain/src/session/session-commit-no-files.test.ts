/**
 * Tests for the noFiles=true --allow-empty commit semantics in sessionCommit.
 *
 * Acceptance tests from mt#1672:
 *   1. noFiles=true on clean tree → empty commit created with --allow-empty, pushed,
 *      returns { success: true, pushed: true, commitHash: <sha> }.
 *   2. noFiles=true with pending changes → existing behavior unchanged
 *      (commit includes file changes, pushed).
 *   3. noFiles=false (default) on clean tree → existing behavior unchanged
 *      (nothingToCommit: true, pushed: false).
 *
 * Strategy: Use real temp git repos initialized in known states (clean, dirty)
 * because sessionCommit shells out to git via dynamic imports. The existing
 * session-commit-ask-emission.test.ts uses the same pattern.
 */

import { describe, test, expect, afterAll } from "bun:test";
// Real FS imports below are required because we need a genuine git repository
// for the tests to exercise the actual detection and commit paths end-to-end.
/* eslint-disable custom/no-real-fs-in-tests */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "path";
import { execSync } from "child_process";
import { sessionCommit } from "./session-commands";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "test-session-uuid",
    repoName: "test-repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#1672",
    agentId: "com.anthropic.claude-code:proc:test-agent",
    ...overrides,
  };
}

function makeSessionProvider(record: SessionRecord, workdir: string): FakeSessionProvider {
  return new FakeSessionProvider({
    initialSessions: [record],
    sessionWorkdir: workdir,
  });
}

/**
 * Create a temporary git repo with one initial commit (clean tree).
 * The repo has no remote, so push will fail — tests that need push to
 * succeed should call addRemote on the repo.
 */
async function makeTmpCleanGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-no-files-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

/**
 * Create a temporary git repo with one initial commit and a pending change
 * (dirty tree).
 */
async function makeTmpDirtyGitRepo(): Promise<string> {
  const dir = await makeTmpCleanGitRepo();
  // Write a file and stage it so it shows as a pending change
  await writeFile(join(dir, "pending.txt"), "pending change"); // eslint-disable-line custom/no-real-fs-in-tests
  execSync("git add pending.txt", { cwd: dir, stdio: "ignore" });
  return dir;
}

/**
 * Create a bare clone of the given repo to act as a remote, then configure
 * the source repo to use it as origin. Returns the bare repo path.
 */
function addLocalRemote(repoDir: string): string {
  const bareDir = `${repoDir}.bare`;
  execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });
  return bareDir;
}

/**
 * Install a real (non-husky) `.git/hooks/pre-commit` script that ALWAYS
 * rejects the commit and writes distinguishing diagnostic text to STDOUT —
 * mirroring the project's real `src/hooks/pre-commit.ts`, whose diagnostics
 * (echo statements, `log.cli`) go to stdout, not stderr (mt#2635).
 */
async function makeTmpCleanGitRepoWithFailingPreCommitHook(): Promise<string> {
  const dir = await makeTmpCleanGitRepo();
  const hookPath = join(dir, ".git", "hooks", "pre-commit");
  const hookScript = [
    "#!/bin/sh",
    'echo "🔍 Running pre-commit validation..."',
    'echo "⚠️ ⚠️ ⚠️ TOO MANY WARNINGS! COMMIT BLOCKED! ⚠️ ⚠️ ⚠️"',
    'echo "ESLint: 10 warnings exceed the threshold"',
    "exit 1",
    "",
  ].join("\n");
  await writeFile(hookPath, hookScript); // eslint-disable-line custom/no-real-fs-in-tests -- real git hook for a real temp repo
  execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" });
  return dir;
}

// Track temp dirs so we can clean up.
const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {}); // eslint-disable-line custom/no-real-fs-in-tests -- cleanup for real tmp git repos created above
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sessionCommit noFiles=true", () => {
  test("creates an empty commit and pushes when tree is clean", async () => {
    const repoDir = await makeTmpCleanGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const record = makeSessionRecord({ sessionId: "no-files-clean-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      { session: "no-files-clean-session", message: "chore: wake webhook", noFiles: true },
      sessionProvider
    );

    // Must succeed and report pushed=true
    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    // Must carry a real commit hash
    expect(result.commitHash).toBeTruthy();
    expect(typeof result.commitHash).toBe("string");
    // Must NOT be the no-op return
    expect(result.nothingToCommit).toBeFalsy();
    // Verify the commit actually exists in the repo
    const log = execSync("git log --oneline -2", { cwd: repoDir }).toString();
    expect(log).toContain("wake webhook");
  });

  test("noFiles=true with pending changes commits the changes normally (unchanged behavior)", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const record = makeSessionRecord({ sessionId: "no-files-dirty-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      {
        session: "no-files-dirty-session",
        message: "chore: commit pending changes",
        noFiles: true,
        all: true,
      },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.commitHash).toBeTruthy();
    expect(result.nothingToCommit).toBeFalsy();
    // The staged file should appear in the commit
    const log = execSync("git log --oneline -2", { cwd: repoDir }).toString();
    expect(log).toContain("commit pending changes");
  });

  test("noFiles=false (default) on clean tree returns nothingToCommit without pushing", async () => {
    const repoDir = await makeTmpCleanGitRepo();
    tmpDirs.push(repoDir);

    const record = makeSessionRecord({ sessionId: "default-clean-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      { session: "default-clean-session", message: "chore: should not commit" },
      sessionProvider
    );

    // Must return the no-op result (existing behavior)
    expect(result.success).toBe(true);
    expect(result.nothingToCommit).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.commitHash).toBeNull();
    expect(result.message).toBe("Nothing to commit, working tree clean");
  });

  // mt#2635 regression test. Before the fix, the noFiles/allow-empty path
  // shelled out via `gitService.execInRepository(...)`, whose catch block
  // (`execInRepositoryImpl`) discards the original subprocess error's
  // `.stdout`/`.stderr` and re-throws a fresh `MinskyError` carrying only a
  // one-line "cleaned" summary. That meant `classifyHookFailure`
  // (workflow-commands.ts), which requires `.stdout`/`.stderr` on the
  // caught error to detect a hook failure, could never classify it — the
  // operator only ever saw an opaque "pre-commit hook blocked the commit"
  // with no diagnostic detail. This test proves the underlying `sessionCommit`
  // throw now carries the REAL hook output, which is the precondition for
  // `classifyHookFailure` (and therefore the enriched MCP error message) to
  // work at all on this path.
  test("noFiles=true on a clean tree preserves the real hook output when pre-commit blocks the commit (mt#2635 regression)", async () => {
    const repoDir = await makeTmpCleanGitRepoWithFailingPreCommitHook();
    tmpDirs.push(repoDir);

    const record = makeSessionRecord({ sessionId: "no-files-hook-blocked-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    let caught: unknown;
    try {
      await sessionCommit(
        {
          session: "no-files-hook-blocked-session",
          message: "chore: wake webhook",
          noFiles: true,
          noStage: true,
        },
        sessionProvider
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const e = caught as Record<string, unknown>;
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const combined = `${stderr}\n${stdout}`;

    // The regression: before mt#2635 this would be empty on both fields
    // (execInRepositoryImpl discarded them), so these assertions would fail
    // against the pre-fix code.
    expect(combined).toContain("TOO MANY WARNINGS");
    expect(combined).toContain("ESLint: 10 warnings exceed the threshold");
  });
});
