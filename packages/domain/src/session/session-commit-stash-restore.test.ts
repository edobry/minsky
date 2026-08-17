/**
 * mt#3660: `session_commit` restores work that a CONFLICTED `session_update`
 * parked, and reports it.
 *
 * Real temp git repos, following session-commit-mass-deletion.test.ts: the
 * behavior under test is git's own (a stash pop is legal only once the merge
 * commit lands and the tree matches the index), so a scripted fake would assert
 * nothing about it.
 *
 * The ordering is the point. Restoring must happen AFTER the commit — so the
 * commit does NOT carry the recovered work, and the operator is told that in the
 * result rather than discovering it from a reviewer three rounds later.
 */
/* eslint-disable custom/no-real-fs-in-tests -- File-scoped by design: the behavior under test is
   git's own stash/merge semantics, so every fs operation here is deliberate. Not re-enabled
   below, since no line in this file could use real fs by accident. */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { sessionCommit } from "./session-commands";
import { SESSION_UPDATE_STASH_MESSAGE } from "./session-stash-restore";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

function makeSessionRecord(sessionId: string): SessionRecord {
  return {
    sessionId,
    repoName: "test-repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#3660",
  };
}

/** A repo on `main` with a local bare remote, so the commit's push succeeds. */
async function makeRepoWithRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-commit-stash-"));
  tmpDirs.push(dir);
  git(dir, "init -b main");
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name Test");
  git(dir, "config commit.gpgsign false");
  await writeFile(join(dir, "mywork.txt"), "original\n");
  git(dir, "add -A");
  git(dir, 'commit -m "init"');

  const bare = `${dir}.bare`;
  tmpDirs.push(bare);
  execSync(`git clone --bare "${dir}" "${bare}"`, { stdio: "ignore" });
  git(dir, `remote add origin "${bare}"`);
  git(dir, "push origin main");
  return dir;
}

describe("sessionCommit — restores update-parked work (mt#3660)", () => {
  test("restores the parked work, reports it, and keeps it OUT of the commit", async () => {
    const dir = await makeRepoWithRemote();

    // A conflicted session_update parked this, exactly as in R1-R4.
    await writeFile(join(dir, "mywork.txt"), "MY-PRECIOUS-WORK\n");
    git(dir, `stash push -m "${SESSION_UPDATE_STASH_MESSAGE}"`);
    expect(await readFile(join(dir, "mywork.txt"), "utf8")).toBe("original\n");

    // The operator resolves the conflict and commits — here, some other file.
    await writeFile(join(dir, "resolved.txt"), "conflict resolution\n");

    const sessionId = "stash-restore-session";
    const result = await sessionCommit(
      { session: sessionId, message: "merge(mt#3660): integrate main into feature", all: true },
      new FakeSessionProvider({
        initialSessions: [makeSessionRecord(sessionId)],
        sessionWorkdir: dir,
      })
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);

    // The work is back in the working tree...
    expect(result.stashRestore?.restored).toBe(true);
    expect(await readFile(join(dir, "mywork.txt"), "utf8")).toBe("MY-PRECIOUS-WORK\n");
    expect(git(dir, "stash list").trim()).toBe("");

    // ...and is NOT part of the commit that just landed. This is the ordering
    // assertion: the commit carries the resolution only, and the restored work
    // is left uncommitted for its own commit.
    const committed = git(dir, "show --stat --name-only --format= HEAD");
    expect(committed).toContain("resolved.txt");
    expect(committed).not.toContain("mywork.txt");
    expect(git(dir, "status --porcelain")).toContain("mywork.txt");
  });

  test("reports nothing when no work was parked (the normal case)", async () => {
    const dir = await makeRepoWithRemote();
    await writeFile(join(dir, "resolved.txt"), "ordinary change\n");

    const sessionId = "no-stash-session";
    const result = await sessionCommit(
      { session: sessionId, message: "chore: ordinary commit", all: true },
      new FakeSessionProvider({
        initialSessions: [makeSessionRecord(sessionId)],
        sessionWorkdir: dir,
      })
    );

    expect(result.success).toBe(true);
    expect(result.stashRestore).toBeUndefined();
  });

  test("leaves an operator-authored stash alone", async () => {
    const dir = await makeRepoWithRemote();
    await writeFile(join(dir, "mywork.txt"), "operator wip\n");
    git(dir, 'stash push -m "my own wip, hands off"');
    await writeFile(join(dir, "resolved.txt"), "ordinary change\n");

    const sessionId = "operator-stash-session";
    const result = await sessionCommit(
      { session: sessionId, message: "chore: ordinary commit", all: true },
      new FakeSessionProvider({
        initialSessions: [makeSessionRecord(sessionId)],
        sessionWorkdir: dir,
      })
    );

    expect(result.success).toBe(true);
    // Never auto-pop a stash the operator pushed by hand.
    expect(result.stashRestore).toBeUndefined();
    expect(git(dir, "stash list").trim()).toContain("my own wip");
    expect(await readFile(join(dir, "mywork.txt"), "utf8")).toBe("original\n");
  });
});
