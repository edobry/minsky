/**
 * REAL-GIT tests for the stash lifecycle (mt#3660).
 *
 * Why real git rather than a scripted fake: the defect this file exists to pin was
 * in a COMMAND STRING, and a fake `execInRepository` accepts any string you hand
 * it. `session-update-stash-restore.test.ts` matches `command.includes("stash
 * list")` and returns canned output, so its two SHA-keyed cases passed for two
 * months while `git stash list --format=%gd %H` — unquoted, hence split by the
 * shell into a `--format=%gd` and a bogus `%H` revision — failed against real git
 * every single time, exited non-zero, and was swallowed by a bare catch. A mock
 * cannot fail here, so it cannot verify anything (mem#704).
 *
 * These tests therefore drive actual `git` in throwaway repos, and reproduce the
 * exact four-recurrence scenario: uncommitted work on a file DISJOINT from the
 * conflict, stashed by an update, with a merge left conflicted in between.
 */
/* eslint-disable custom/no-real-fs-in-tests -- File-scoped by design, not per-call: every
   operation here exists to drive REAL git in a throwaway repo, which is the entire point (see
   the header). An in-memory fs would reproduce the defect this file pins — a probe that cannot
   observe the real thing. Deliberately not re-enabled below, since there is no line in this
   file where real fs access would be accidental. */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import {
  describeParkedStash,
  findSessionUpdateStash,
  restoreSessionStash,
  restoreUpdateStashAfterCommit,
  SESSION_UPDATE_STASH_MESSAGE,
  type StashRestoreGitDeps,
} from "./session-stash-restore";

/** The uncommitted work an update parks — distinctive so a wrong tree is obvious. */
const PARKED_CONTENT = "MY-PRECIOUS-WORK\n";
/** What `mywork.txt` holds in the base commit, i.e. the un-restored state. */
const BASE_CONTENT = "original\n";
/** `git status` in the porcelain form these tests assert emptiness against. */
const STATUS_PORCELAIN = "status --porcelain";

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

/**
 * A `StashRestoreGitDeps` backed by real git, mirroring `execInRepositoryImpl`'s
 * contract: the command string is run through a shell with cwd=workdir, and a
 * non-zero exit THROWS. Both halves matter — the shell is what splits an unquoted
 * format string, and the throw is what the production bare-catch swallowed.
 */
function realGitDeps(): StashRestoreGitDeps {
  return {
    async execInRepository(workdir: string, command: string): Promise<string> {
      return execSync(command, { cwd: workdir, stdio: ["ignore", "pipe", "ignore"] }).toString();
    },
    async popStash(workdir: string) {
      execSync("git stash pop", { cwd: workdir, stdio: ["ignore", "pipe", "ignore"] });
      return { workdir, stashed: true };
    },
  };
}

/** A repo whose `feature` branch conflicts with `main` on ONE file only. */
async function makeConflictingRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-stash-real-git-"));
  tmpDirs.push(dir);
  git(dir, "init -b main");
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name Test");
  git(dir, "config commit.gpgsign false");

  await writeFile(join(dir, "conflict.txt"), "base\n");
  await writeFile(join(dir, "mywork.txt"), BASE_CONTENT);
  git(dir, "add -A");
  git(dir, 'commit -m "base"');

  git(dir, "checkout -b feature");
  await writeFile(join(dir, "conflict.txt"), "feature-side\n");
  git(dir, "add -A");
  git(dir, 'commit -m "feature"');

  git(dir, "checkout main");
  await writeFile(join(dir, "conflict.txt"), "main-side\n");
  git(dir, "add -A");
  git(dir, 'commit -m "main"');

  git(dir, "checkout feature");
  return dir;
}

/** Park uncommitted work the way `session_update` does, returning its SHA. */
async function stashLikeSessionUpdate(dir: string, content: string): Promise<string> {
  await writeFile(join(dir, "mywork.txt"), content);
  git(dir, `stash push -m "${SESSION_UPDATE_STASH_MESSAGE}"`);
  return git(dir, "rev-parse stash@{0}").trim();
}

describe("findSessionUpdateStash (real git)", () => {
  test("finds an update-parked stash and reports its ref, sha and files", async () => {
    const dir = await makeConflictingRepo();
    const sha = await stashLikeSessionUpdate(dir, PARKED_CONTENT);

    const found = await findSessionUpdateStash(dir, realGitDeps());

    // This is the assertion the broken format string could never satisfy: it
    // requires `git stash list --format=...` to actually return rows.
    expect(found).toBeDefined();
    expect(found?.ref).toBe("stash@{0}");
    expect(found?.sha).toBe(sha);
    expect(found?.files).toEqual(["mywork.txt"]);
  });

  test("ignores an operator-authored stash — only update-parked work is claimed", async () => {
    const dir = await makeConflictingRepo();
    await writeFile(join(dir, "mywork.txt"), "operator wip\n");
    git(dir, 'stash push -m "my own wip, do not touch"');

    expect(await findSessionUpdateStash(dir, realGitDeps())).toBeUndefined();
  });

  test("returns undefined when there are no stashes at all (the normal case)", async () => {
    const dir = await makeConflictingRepo();
    expect(await findSessionUpdateStash(dir, realGitDeps())).toBeUndefined();
  });
});

describe("describeParkedStash (real git)", () => {
  test("names the stash ref and the files it holds, without disturbing it", async () => {
    const dir = await makeConflictingRepo();
    const sha = await stashLikeSessionUpdate(dir, PARKED_CONTENT);

    const described = await describeParkedStash(dir, realGitDeps(), sha);

    expect(described.stashRef).toBe("stash@{0}");
    expect(described.parkedFiles).toEqual(["mywork.txt"]);
    // Describing must not consume the stash — the conflict path still needs it there.
    expect(git(dir, "stash list").trim()).toContain(SESSION_UPDATE_STASH_MESSAGE);
  });

  test("resolves OUR buried stash to its real ref when a newer stash sits on top", async () => {
    const dir = await makeConflictingRepo();
    const ourSha = await stashLikeSessionUpdate(dir, PARKED_CONTENT);
    // An unrelated stash pushed afterwards shifts ours down to stash@{1}.
    await writeFile(join(dir, "conflict.txt"), "unrelated edit\n");
    git(dir, 'stash push -m "something else"');

    const described = await describeParkedStash(dir, realGitDeps(), ourSha);

    // Positionally this is stash@{1}; the SHA is what identifies it. Before
    // mt#3660 this silently reported stash@{0} — the WRONG entry.
    expect(described.stashRef).toBe("stash@{1}");
    expect(described.parkedFiles).toEqual(["mywork.txt"]);
  });
});

describe("restoreUpdateStashAfterCommit (real git)", () => {
  test("the conflicted-merge scenario: git refuses the pop mid-merge, and the restore succeeds once the merge commit lands", async () => {
    const dir = await makeConflictingRepo();
    await stashLikeSessionUpdate(dir, PARKED_CONTENT);

    // The merge conflicts on conflict.txt — a file the stash does not touch,
    // matching all four recorded recurrences (conflicted and stashed paths DISJOINT).
    let mergeConflicted = false;
    try {
      git(dir, "merge main");
    } catch {
      mergeConflicted = true;
    }
    expect(mergeConflicted).toBe(true);
    expect(git(dir, STATUS_PORCELAIN).includes("UU conflict.txt")).toBe(true);

    // FIRST HALF — mid-merge the pop is genuinely impossible. This is the
    // empirical form of what `man git-stash` states for `pop`: "the working
    // directory must match the index". It is why session_update's conflict path
    // may only NAME the stash, and why restoring belongs at the next commit.
    let popRefusedMidMerge = false;
    try {
      git(dir, "stash pop");
    } catch {
      popRefusedMidMerge = true;
    }
    expect(popRefusedMidMerge).toBe(true);
    // Non-destructive: git's documented guarantee is that a failed apply leaves
    // the entry in the stash list. The work is never at risk.
    expect(git(dir, "stash list").trim()).toContain(SESSION_UPDATE_STASH_MESSAGE);

    // Resolve the conflict and complete the merge, as the operator/agent does.
    await writeFile(join(dir, "conflict.txt"), "resolved\n");
    git(dir, "add -A");
    git(dir, 'commit -m "merge main into feature"');

    // The merge commit does NOT contain the stashed work — this is precisely the
    // false-message artifact from R1-R4.
    expect(await readFile(join(dir, "mywork.txt"), "utf8")).toBe(BASE_CONTENT);

    // SECOND HALF — now the tree is clean and the restore works.
    const outcome = await restoreUpdateStashAfterCommit(dir, realGitDeps());

    expect(outcome).toBeDefined();
    expect(outcome?.restored).toBe(true);
    expect(await readFile(join(dir, "mywork.txt"), "utf8")).toBe(PARKED_CONTENT);
    // Restored work is left UNCOMMITTED, to be committed separately.
    expect(git(dir, STATUS_PORCELAIN).includes("mywork.txt")).toBe(true);
    expect(git(dir, "stash list").trim()).toBe("");
  });

  test("returns undefined and touches nothing when no update-parked stash exists", async () => {
    const dir = await makeConflictingRepo();
    await writeFile(join(dir, "mywork.txt"), "uncommitted, never stashed\n");

    expect(await restoreUpdateStashAfterCommit(dir, realGitDeps())).toBeUndefined();
    // The working tree is untouched.
    expect(await readFile(join(dir, "mywork.txt"), "utf8")).toBe("uncommitted, never stashed\n");
  });

  test("refuses to pop when an operator stash sits on top of the update-parked one", async () => {
    const dir = await makeConflictingRepo();
    await stashLikeSessionUpdate(dir, PARKED_CONTENT);
    await writeFile(join(dir, "conflict.txt"), "operator wip\n");
    git(dir, 'stash push -m "operator wip"');

    const outcome = await restoreUpdateStashAfterCommit(dir, realGitDeps());

    // mt#2325 shipped this refusal; it could never fire until mt#3660 fixed the
    // format string, because the SHA lookup always failed and fell back to a
    // positional pop — which would have applied the OPERATOR's stash.
    expect(outcome?.restored).toBe(false);
    expect(outcome?.stashRef).toBe("stash@{1}");
    expect(outcome?.recovery).toContain("git stash pop stash@{1}");
    // Both stashes still present: nothing was popped.
    expect(git(dir, "stash list").split("\n").filter(Boolean)).toHaveLength(2);
    expect(await readFile(join(dir, "conflict.txt"), "utf8")).toBe("feature-side\n");
  });
});

/**
 * mt#4307 — a stash pop that CONFLICTS must not leave the working tree carrying
 * conflict markers.
 *
 * The scenario every test above avoids: their stash touches a file DISJOINT from
 * the conflict, so the pop either succeeds or is refused without git ever
 * attempting a merge. Here the stash touches the SAME file the merge resolved, so
 * git attempts the merge, writes `<<<<<<<` / `=======` / `>>>>>>>` into it, and
 * records it unmerged — and until this task, `restoreSessionStash` returned
 * `restored: false` over that corrupted tree and let the caller carry on.
 *
 * What that cost, from the originating incident: `session_commit` popped here,
 * then pushed, and the pre-push gated suite ran against the corrupted tree —
 * twenty `src/cockpit/**` tests failing on a JSON file that began with a conflict
 * marker, none of them related to the change. The push error carried the test
 * output; the cause sat in a different field of the same payload.
 *
 * Real git, not a fake, for the same reason as the header: a scripted
 * `execInRepository` returns whatever canned string it was given for
 * `diff --diff-filter=U`, so it cannot tell a conflicted pop from a refused one —
 * which is the exact distinction the fix turns on.
 */
describe("restoreSessionStash — a CONFLICTED pop is rolled back (mt#4307)", () => {
  /** Git's own conflict markers, anchored at line start (the spec's regex). */
  const MARKER_RE = /^(<{7}|={7}|>{7})( |$)/m;

  /** Every tracked file's working-tree content, as one string per path. */
  async function trackedContents(dir: string): Promise<Array<[string, string]>> {
    const files = git(dir, "ls-files")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const out: Array<[string, string]> = [];
    for (const f of files) {
      out.push([f, await readFile(join(dir, f), "utf8")]);
    }
    return out;
  }

  /**
   * A repo left exactly where the incident left it: the merge commit has landed
   * and an update-parked stash is sitting there whose pop WILL conflict, because
   * it edits the same file the merge just resolved.
   */
  async function makeRepoWherePopWillConflict(): Promise<string> {
    const dir = await makeConflictingRepo();
    // The uncommitted work is on the CONFLICTING file this time — that is what
    // makes the pop attempt a merge rather than be refused outright.
    await writeFile(join(dir, "conflict.txt"), "my uncommitted edit\n");
    git(dir, `stash push -m "${SESSION_UPDATE_STASH_MESSAGE}"`);

    let mergeConflicted = false;
    try {
      git(dir, "merge main");
    } catch {
      mergeConflicted = true;
    }
    expect(mergeConflicted).toBe(true);

    await writeFile(join(dir, "conflict.txt"), "resolved\n");
    git(dir, "add -A");
    git(dir, 'commit -m "merge main into feature"');
    return dir;
  }

  test("NEGATIVE CONTROL: a raw pop in this scenario really does write markers", async () => {
    // Without this, the assertions below would be satisfied by a scenario that
    // never produced markers in the first place — a probe that cannot fail
    // (mem#704). This pins that the setup genuinely reproduces the corruption,
    // so "no markers" downstream is the FIX talking and not the fixture.
    const dir = await makeRepoWherePopWillConflict();

    let popFailed = false;
    try {
      git(dir, "stash pop");
    } catch {
      popFailed = true;
    }

    expect(popFailed).toBe(true);
    const corrupted = await readFile(join(dir, "conflict.txt"), "utf8");
    expect(MARKER_RE.test(corrupted)).toBe(true);
    // git also records the path unmerged — the signal the fix classifies on.
    expect(git(dir, "diff --name-only --diff-filter=U").trim()).toBe("conflict.txt");
  });

  test("leaves NO conflict markers in any tracked file, and the work stays recoverable", async () => {
    const dir = await makeRepoWherePopWillConflict();

    const outcome = await restoreUpdateStashAfterCommit(dir, realGitDeps());

    expect(outcome).toBeDefined();
    expect(outcome?.restored).toBe(false);
    expect(outcome?.rolledBack).toBe(true);
    expect(outcome?.conflictedFiles).toEqual(["conflict.txt"]);

    // AT1's assertion: no tracked file carries a marker line.
    for (const [path, content] of await trackedContents(dir)) {
      expect({ path, hasMarker: MARKER_RE.test(content) }).toEqual({ path, hasMarker: false });
    }

    // The tree is back to its pre-pop state, exactly.
    expect(await readFile(join(dir, "conflict.txt"), "utf8")).toBe("resolved\n");
    expect(git(dir, STATUS_PORCELAIN).trim()).toBe("");
    expect(git(dir, "diff --name-only --diff-filter=U").trim()).toBe("");

    // "still recoverable": the work is intact in the stash, and the report says
    // how to get it. Rolling back must never mean discarding.
    expect(git(dir, "stash list").trim()).toContain(SESSION_UPDATE_STASH_MESSAGE);
    expect(git(dir, "stash show -p stash@{0}")).toContain("my uncommitted edit");
    expect(outcome?.recovery).toContain("git stash pop stash@{0}");
  });

  test("the report names the conflict rather than only 'could not be restored'", async () => {
    const dir = await makeRepoWherePopWillConflict();

    const outcome = await restoreUpdateStashAfterCommit(dir, realGitDeps());

    // SC2: the caller must be able to tell a conflicted pop from a refused one
    // without parsing git's error text.
    expect(outcome?.recovery).toContain("CONFLICTED");
    expect(outcome?.recovery).toContain("conflict.txt");
    expect(outcome?.recovery).toContain("NO conflict markers");
  });

  test("refuses to roll back when the stash entry did not survive — markers are then the only copy", async () => {
    const dir = await makeRepoWherePopWillConflict();

    // Force the fail-closed branch: the pop conflicts, but by the time we check,
    // the stash entry is gone. Resetting here would destroy the only copy of the
    // work, so the fix must leave the tree alone and say so.
    const deps = realGitDeps();
    const guarded: StashRestoreGitDeps = {
      execInRepository: deps.execInRepository,
      async popStash(workdir: string) {
        try {
          return await deps.popStash(workdir);
        } finally {
          // Drop our entry the instant the pop conflicts.
          try {
            execSync("git stash drop", { cwd: workdir, stdio: ["ignore", "pipe", "ignore"] });
          } catch {
            // Already gone — that is the state we are arranging for anyway.
          }
        }
      },
    };

    const outcome = await restoreUpdateStashAfterCommit(dir, guarded);

    expect(outcome?.restored).toBe(false);
    expect(outcome?.rolledBack).toBe(false);
    expect(outcome?.recovery).toContain("ONLY copy");
    // The markers are still there — deliberately. Destroying unrecoverable work
    // to satisfy a cleanliness invariant would be the worse failure.
    expect(MARKER_RE.test(await readFile(join(dir, "conflict.txt"), "utf8"))).toBe(true);
  });

  test("refuses to roll back when no stash SHA was captured, even though a stash exists", async () => {
    // PR #3201 R1 (BLOCKING): the presence check used to ask "is there ANY stash
    // entry?" when no SHA had been captured. An unrelated stash — one the operator
    // pushed by hand — would then green-light `git reset --hard` over a conflicted
    // tree whose work that stash does not contain. Existence of *a* stash is not
    // evidence that *this* work is in it.
    const dir = await makeRepoWherePopWillConflict();

    // No SHA passed — the positional-pop fallback, where the code cannot tell OUR
    // entry from anyone else's. The fix refuses on that basis alone, which is what
    // makes the unrelated-stash case safe too: mere existence is no longer
    // consulted, so there is nothing for a foreign stash to satisfy.
    const outcome = await restoreSessionStash(dir, realGitDeps(), undefined);

    expect(outcome.restored).toBe(false);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.recovery).toContain("could not be identified");
    // Fail closed: the tree keeps its markers rather than being reset against a
    // stash that may belong to someone else.
    expect(MARKER_RE.test(await readFile(join(dir, "conflict.txt"), "utf8"))).toBe(true);
    // The work is still parked, so nothing was destroyed by refusing.
    expect(git(dir, "stash list").trim()).toContain(SESSION_UPDATE_STASH_MESSAGE);
  });
});
