/**
 * mt#3049: proves the structured partial-outcome fields the domain
 * `sessionCommit()` now returns (pushError, pushTimedOut, resumedPush,
 * nothingToCommit) actually survive `createSessionCommitCommand`'s adapter
 * mapping to the MCP-visible payload — not just present on the domain
 * result. Before this fix, the adapter's `execute()` return statement
 * explicitly listed field names and silently dropped anything not on that
 * list, which would have made the domain-level fix invisible to any real
 * MCP caller.
 *
 * Strategy mirrors workflow-commands-commit.test.ts: exercises the real
 * `createSessionCommitCommand` factory (not a mock), backed by a
 * `FakeSessionProvider` pointed at a real temp git repo (same pattern as
 * the domain-level session-commit-push-outcome.test.ts), since
 * `sessionCommit()` shells out to git.
 */

import { describe, test, expect, afterAll } from "bun:test";
// Real FS imports below are required because we need a genuine git repository
// for sessionCommit to exercise the actual commit/push paths end-to-end.
/* eslint-disable custom/no-real-fs-in-tests */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "path";
import { execSync } from "child_process";
import { createSessionCommitCommand } from "./workflow-commands";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import type { SessionCommandDependencies } from "./types";

function buildGetDeps(sessionDB: FakeSessionProvider): () => Promise<SessionCommandDependencies> {
  return async () =>
    ({
      sessionProvider: sessionDB,
    }) as unknown as SessionCommandDependencies;
}

async function makeTmpDirtyGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-mcp-commit-push-outcome-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  await writeFile(join(dir, "pending.txt"), "pending change"); // eslint-disable-line custom/no-real-fs-in-tests
  execSync("git add pending.txt", { cwd: dir, stdio: "ignore" });
  return dir;
}

/**
 * Bare-clone the repo as its own origin, with a `pre-receive` hook that
 * sleeps `sleepSeconds` before accepting the push — fires BEFORE the remote
 * updates its ref, so a client-side timeout during the sleep is genuinely
 * correct that the push has NOT landed (mt#3177 AT1 shape:
 * `pushUnconfirmed`). Mirrors `addLocalRemoteWithHook` in the domain-level
 * session-commit-push-outcome.test.ts.
 */
async function addHangingBareRemote(repoDir: string, sleepSeconds: number): Promise<string> {
  const bareDir = `${repoDir}.bare`;
  execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });
  const hookPath = join(bareDir, "hooks", "pre-receive");
  const hookScript = ["#!/bin/sh", `sleep ${sleepSeconds}`, "exit 0", ""].join("\n");
  await writeFile(hookPath, hookScript); // eslint-disable-line custom/no-real-fs-in-tests -- real git hook for a real temp bare repo
  execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" });
  return bareDir;
}

/** Real `.git/hooks/pre-commit` that sleeps before succeeding — see the
 * identical helper's doc comment in session-commit-push-outcome.test.ts. */
async function makeTmpCleanGitRepoWithSlowPreCommitHook(sleepSeconds: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-mcp-commit-slow-hook-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  const hookPath = join(dir, ".git", "hooks", "pre-commit");
  const hookScript = ["#!/bin/sh", `sleep ${sleepSeconds}`, "exit 0", ""].join("\n");
  await writeFile(hookPath, hookScript); // eslint-disable-line custom/no-real-fs-in-tests -- real git hook for a real temp repo
  execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" });
  return dir;
}

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {}); // eslint-disable-line custom/no-real-fs-in-tests -- cleanup for real tmp git repos created above
  }
});

describe("session.commit MCP command surfaces the mt#3049 structured partial outcome", () => {
  test("push failure after successful commit: pushError + pushed:false reach the returned payload", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    tmpDirs.push(repoDir);
    execSync(`git remote add origin "${repoDir}/does-not-exist.bare"`, {
      cwd: repoDir,
      stdio: "ignore",
    });

    const sessionDB = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "mcp-push-fail-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/edobry/minsky.git",
          createdAt: new Date().toISOString(),
          taskId: "mt#3049",
        },
      ],
      sessionWorkdir: repoDir,
    });
    const command = createSessionCommitCommand(buildGetDeps(sessionDB));

    const result = await command.execute(
      { sessionId: "mcp-push-fail-session", message: "test: mcp push failure", all: true },
      {}
    );

    expect((result as Record<string, unknown>).success).toBe(true);
    expect((result as Record<string, unknown>).commitHash).toBeTruthy();
    expect((result as Record<string, unknown>).pushed).toBe(false);
    expect((result as Record<string, unknown>).pushError).toBeTruthy();
  });

  // Review R1 (PR #2183): commitTimeoutMs/pushTimeoutMs must actually reach
  // sessionCommit() from an MCP-shaped params object, not just be accepted
  // by the schema and dropped before the domain call.
  test("commitTimeoutMs supplied via MCP params actually bounds the commit phase", async () => {
    const repoDir = await makeTmpCleanGitRepoWithSlowPreCommitHook(5);
    tmpDirs.push(repoDir);
    await writeFile(join(repoDir, "pending.txt"), "pending change"); // eslint-disable-line custom/no-real-fs-in-tests
    execSync("git add pending.txt", { cwd: repoDir, stdio: "ignore" });

    const sessionDB = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "mcp-commit-timeout-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/edobry/minsky.git",
          createdAt: new Date().toISOString(),
          taskId: "mt#3049",
        },
      ],
      sessionWorkdir: repoDir,
    });
    const command = createSessionCommitCommand(buildGetDeps(sessionDB));

    await expect(
      command.execute(
        {
          sessionId: "mcp-commit-timeout-session",
          message: "test: mcp commit should time out",
          all: true,
          commitTimeoutMs: 100,
        },
        {}
      )
    ).rejects.toThrow(/commit phase/);
  });

  // mt#3205 Gap 2 (AT2): sessionCommit with an unconfirmed push must not
  // report success:true — a caller checking only `success` (the common
  // pattern) must not see a pass. Forces a genuine pushUnconfirmed via a
  // pre-receive hook (fires BEFORE the remote ref updates) + a client-side
  // pushTimeoutMs far below the hook's sleep, the same real-hang mechanism
  // session-commit-push-outcome.test.ts's mt#3177 AT1 test uses — proving
  // the adapter's `success` override end-to-end, not just against a canned
  // mock.
  test("push-timeout unconfirmed after successful commit: success is false, not true (mt#3205 Gap 2)", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    tmpDirs.push(repoDir);
    const bareDir = await addHangingBareRemote(repoDir, 2);
    tmpDirs.push(bareDir);

    const sessionDB = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "mcp-push-unconfirmed-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/edobry/minsky.git",
          createdAt: new Date().toISOString(),
          taskId: "mt#3205",
        },
      ],
      sessionWorkdir: repoDir,
    });
    const command = createSessionCommitCommand(buildGetDeps(sessionDB));

    const result = (await command.execute(
      {
        sessionId: "mcp-push-unconfirmed-session",
        message: "test: mcp push should be unconfirmed",
        all: true,
        // Far below the hook's 2s sleep, so the timeout deterministically
        // wins; ls-remote's follow-up check (also bounded, but fast against
        // a local bare repo) then finds the remote genuinely has not
        // advanced yet (pre-receive fires before the ref update).
        pushTimeoutMs: 20,
      },
      {}
    )) as Record<string, unknown>;

    expect(result.commitHash).toBeTruthy();
    expect(result.pushed).toBe(false);
    expect(result.pushUnconfirmed).toBe(true);
    // The critical assertion: a caller checking ONLY `success` must not
    // read this as a pass.
    expect(result.success).toBe(false);
  }, 15000);
});
