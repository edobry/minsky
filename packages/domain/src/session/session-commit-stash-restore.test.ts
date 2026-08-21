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

/** The distinctive uncommitted work an update parks, so a wrong tree is obvious. */
const PARKED_WORK = "MY-PRECIOUS-WORK\n";

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
    await writeFile(join(dir, "mywork.txt"), PARKED_WORK);
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
    expect(await readFile(join(dir, "mywork.txt"), "utf8")).toBe(PARKED_WORK);
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

/**
 * mt#4307: when the post-commit pop CONFLICTS, `session_commit` must not hand the
 * push a corrupted working tree, and must not bury the reason.
 *
 * The originating incident, in order: the commit landed clean, the pop conflicted
 * and wrote markers into four rule files plus
 * `src/generated/interceptor-catalog.json`, and the push then ran the pre-push
 * gated suite against THAT tree. Twenty `src/cockpit/**` tests failed identically
 * on a JSON file that now began with `<`, none of them touched by the change.
 * `pushError` carried the test output; `stashRestore.error` — a different field of
 * the same payload — carried "Failed to pop stash". The natural reading was "my
 * change broke twenty cockpit tests", which was false and cost a diagnosis cycle.
 *
 * These tests pin both halves: the tree the push sees is clean (SC1/SC3), and the
 * result LEADS with the pop failure (SC2).
 */
describe("sessionCommit — a conflicted post-commit pop (mt#4307)", () => {
  const MARKER_RE = /^(<{7}|={7}|>{7})( |$)/m;

  /**
   * Park work on `mywork.txt`, then commit a DIFFERENT content for that same
   * file — so the pop that follows the commit has to merge, and conflicts.
   * (mt#3660's tests all park work on a file the commit never touches, which is
   * why their pop always succeeds.)
   */
  async function commitWithConflictingParkedWork(sessionId: string) {
    const dir = await makeRepoWithRemote();

    await writeFile(join(dir, "mywork.txt"), PARKED_WORK);
    git(dir, `stash push -m "${SESSION_UPDATE_STASH_MESSAGE}"`);

    // The merge resolution touches the same file the stash holds.
    await writeFile(join(dir, "mywork.txt"), "resolved-during-merge\n");

    const result = await sessionCommit(
      { session: sessionId, message: "merge(mt#4307): integrate main into feature", all: true },
      new FakeSessionProvider({
        initialSessions: [makeSessionRecord(sessionId)],
        sessionWorkdir: dir,
      })
    );
    return { dir, result };
  }

  test("the commit lands and pushes, and the tree the push saw carries NO markers", async () => {
    const { dir, result } = await commitWithConflictingParkedWork("conflicted-pop-session");

    // The commit itself was never in doubt — it is the tree AFTER it that was.
    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.stashRestore?.restored).toBe(false);
    expect(result.stashRestore?.rolledBack).toBe(true);
    expect(result.stashRestore?.conflictedFiles).toContain("mywork.txt");

    // SC1/SC3: this is the state the pre-push gated suite runs against.
    expect(MARKER_RE.test(await readFile(join(dir, "mywork.txt"), "utf8"))).toBe(false);
    expect(await readFile(join(dir, "mywork.txt"), "utf8")).toBe("resolved-during-merge\n");
    expect(git(dir, "diff --name-only --diff-filter=U").trim()).toBe("");
    expect(git(dir, "status --porcelain").trim()).toBe("");

    // The parked work is not lost — it is still in the stash, recoverable.
    expect(git(dir, "stash list").trim()).toContain(SESSION_UPDATE_STASH_MESSAGE);
    expect(git(dir, "stash show -p stash@{0}")).toContain(PARKED_WORK.trim());
  });

  test("the result LEADS with the pop failure rather than burying it in a side field", async () => {
    const { result } = await commitWithConflictingParkedWork("conflicted-pop-message-session");

    // SC2. Before this task `message` was the commit subject and the only trace
    // of the pop failure was `stashRestore.error`, which nothing surfaced.
    expect(result.message).toContain("session_update");
    expect(result.message).toContain("FAILED");
    expect(result.message).toContain("conflicted");
    expect(result.message).toContain("rolled back");
    expect(result.message).toContain("NOT in this commit");
    // And it does not lead with the commit subject as though nothing happened.
    expect(result.message).not.toBe("merge(mt#4307): integrate main into feature");
  });
});
