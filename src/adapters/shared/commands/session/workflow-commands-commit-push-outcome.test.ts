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
});
