/**
 * Tests for mt#2325: session_update must restore the stash it creates for an
 * initially-dirty working tree — and when it cannot, surface the parked work
 * NON-silently instead of returning a misleading bare success.
 *
 * Two defect mechanisms are covered:
 *  1. Success-path pop failure was swallowed (`log.warn` only) and `{success:true}`
 *     returned — the operator never learned work was parked in stash@{0}.
 *  2. Early-return paths (already-merged skip) abandoned the stash without even
 *     attempting a pop.
 *
 * Also covers criterion 3: generated-file collisions that block the pop are
 * auto-handled (the regenerated working-tree copy is discarded, pop retried).
 */

import { describe, it, expect } from "bun:test";
import { updateSessionImpl } from "./session-update-operations";
import {
  restoreSessionStash,
  isGeneratedPath,
  type StashRestoreGitDeps,
} from "./session-stash-restore";
import { FakeGitService } from "../git/fake-git-service";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";

const SESSION_ID = "test-session-mt-2325";
const WORKDIR = "/mock/session/workdir";
/** The git command restoreSessionStash uses to enumerate parked files. */
const STASH_SHOW_CMD = "stash show --name-only";

function makeSessionRecord(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#2325",
    branch: "task/mt-2325",
  };
}

function makeBaseParams(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    remote: "origin",
    noStash: false,
    noPush: true,
    force: false,
    skipConflictCheck: false,
    autoResolveDeleteConflicts: false,
    dryRun: false,
    skipIfAlreadyMerged: false,
    ...overrides,
  };
}

/** A FakeGitService that reports a dirty tree so updateSessionImpl stashes. */
function makeDirtyTreeGitService(): FakeGitService {
  const svc = new FakeGitService({ defaultBranch: "task/mt-2325", sessionWorkdir: WORKDIR });
  svc.hasUncommittedChanges = async () => true;
  return svc;
}

function makeSessionDB() {
  return new FakeSessionProvider({
    initialSessions: [makeSessionRecord()],
    sessionWorkdir: WORKDIR,
  });
}

describe("updateSessionImpl — stash restore lifecycle (mt#2325)", () => {
  it("dirty tree + clean pop: restores the stash and reports restored=true", async () => {
    const gitService = makeDirtyTreeGitService();
    const sessionDB = makeSessionDB();

    const result = await updateSessionImpl(makeBaseParams(), {
      gitService,
      sessionDB,
      getCurrentSession: async () => undefined,
    });

    expect(result.stashRestore).toBeDefined();
    expect(result.stashRestore?.stashed).toBe(true);
    expect(result.stashRestore?.restored).toBe(true);
    // The stash was actually popped.
    expect(gitService.popStashCalls.length).toBe(1);
  });

  it("dirty tree + pop conflict: NON-silent result naming stash@{0} and parked files", async () => {
    const gitService = makeDirtyTreeGitService();
    // First (and only) pop fails — simulates the generated-file-collision incident
    // where the pop is blocked. Parked files are non-generated here, so no retry.
    gitService.setPopStashErrors([new Error("Your local changes would be overwritten by merge")]);
    gitService.setCommandResponse(
      STASH_SHOW_CMD,
      "src/session/chunked-review.ts\nsrc/session/chunked-review.test.ts"
    );
    const sessionDB = makeSessionDB();

    const result = await updateSessionImpl(makeBaseParams(), {
      gitService,
      sessionDB,
      getCurrentSession: async () => undefined,
    });

    const stash = result.stashRestore;
    expect(stash).toBeDefined();
    expect(stash?.stashed).toBe(true);
    expect(stash?.restored).toBe(false);
    expect(stash?.stashRef).toBe("stash@{0}");
    expect(stash?.parkedFiles).toContain("src/session/chunked-review.ts");
    expect(stash?.parkedFiles).toContain("src/session/chunked-review.test.ts");
    expect(stash?.error).toBeTruthy();
    expect(stash?.recovery).toContain("stash@{0}");
  });

  it("generated-file collision: discards the regenerated file and retries the pop", async () => {
    const gitService = makeDirtyTreeGitService();
    // Pop fails once (blocked by the generated file), succeeds after the discard.
    gitService.setPopStashErrors([
      new Error("Your local changes to the following files would be overwritten by merge"),
      undefined,
    ]);
    gitService.setCommandResponse(
      STASH_SHOW_CMD,
      "src/generated/completion-manifest.json\nsrc/session/chunked-review.ts"
    );
    const sessionDB = makeSessionDB();

    const result = await updateSessionImpl(makeBaseParams(), {
      gitService,
      sessionDB,
      getCurrentSession: async () => undefined,
    });

    const stash = result.stashRestore;
    expect(stash?.restored).toBe(true);
    expect(stash?.autoRestoredFiles).toContain("src/generated/completion-manifest.json");
    // Two pop attempts: the blocked one, then the successful retry.
    expect(gitService.popStashCalls.length).toBe(2);
    // The generated file's working-tree copy was discarded before the retry.
    const discardedGenerated = gitService.recordedCommands.some(
      (c) => c.command.includes("checkout --") && c.command.includes("src/generated/")
    );
    expect(discardedGenerated).toBe(true);
  });

  it("clean tree: no stash created, no pop attempted, stashRestore undefined", async () => {
    // Default FakeGitService.hasUncommittedChanges → false, so nothing is stashed.
    const gitService = new FakeGitService({
      defaultBranch: "task/mt-2325",
      sessionWorkdir: WORKDIR,
    });
    const sessionDB = makeSessionDB();

    const result = await updateSessionImpl(makeBaseParams(), {
      gitService,
      sessionDB,
      getCurrentSession: async () => undefined,
    });

    expect(result.stashRestore).toBeUndefined();
    expect(gitService.popStashCalls.length).toBe(0);
  });

  it("noStash: dirty tree is not stashed and pop is never attempted", async () => {
    const gitService = makeDirtyTreeGitService();
    const sessionDB = makeSessionDB();

    const result = await updateSessionImpl(makeBaseParams({ noStash: true }), {
      gitService,
      sessionDB,
      getCurrentSession: async () => undefined,
    });

    expect(result.stashRestore).toBeUndefined();
    expect(gitService.popStashCalls.length).toBe(0);
  });

  it("early-return (already-merged skip) restores the stash instead of abandoning it", async () => {
    const gitService = makeDirtyTreeGitService();
    // smartSessionUpdate reports the session is already in base → early return path.
    gitService.setSmartSessionUpdateResult({
      workdir: WORKDIR,
      updated: false,
      skipped: true,
      reason: "Session changes already in base branch",
    });
    const sessionDB = makeSessionDB();

    const result = await updateSessionImpl(makeBaseParams(), {
      gitService,
      sessionDB,
      getCurrentSession: async () => undefined,
    });

    // The stash created before the early return is restored, not silently parked.
    expect(result.stashRestore?.stashed).toBe(true);
    expect(result.stashRestore?.restored).toBe(true);
    expect(gitService.popStashCalls.length).toBe(1);
  });
});

describe("isGeneratedPath", () => {
  it("matches paths under a generated/ directory segment", () => {
    expect(isGeneratedPath("src/generated/completion-manifest.json")).toBe(true);
    expect(isGeneratedPath("packages/domain/src/generated/x.ts")).toBe(true);
    expect(isGeneratedPath("generated/top-level.json")).toBe(true);
  });

  it("does not match ordinary source paths", () => {
    expect(isGeneratedPath("src/session/chunked-review.ts")).toBe(false);
    expect(isGeneratedPath("src/regenerated-utils.ts")).toBe(false);
    expect(isGeneratedPath("docs/generated-output-notes.md")).toBe(false);
  });
});

describe("restoreSessionStash", () => {
  /** Minimal scripted git surface for direct unit testing. */
  function makeGit(
    popOutcomes: Array<Error | undefined>,
    stashedFiles: string
  ): StashRestoreGitDeps & { popCalls: number; checkouts: string[] } {
    let popIndex = 0;
    const checkouts: string[] = [];
    return {
      popCalls: 0,
      checkouts,
      async popStash() {
        const outcome = popOutcomes[popIndex++];

        (this as any).popCalls = popIndex;
        if (outcome) throw outcome;
        return { workdir: "/w", stashed: true };
      },
      async execInRepository(_workdir: string, command: string) {
        if (command.includes(STASH_SHOW_CMD)) return stashedFiles;
        if (command.includes("checkout --")) {
          checkouts.push(command);
          return "";
        }
        return "";
      },
    };
  }

  it("returns restored=true on a clean pop", async () => {
    const git = makeGit([undefined], "");
    const outcome = await restoreSessionStash("/w", git);
    expect(outcome).toEqual({ stashed: true, restored: true, stashRef: "stash@{0}" });
    expect(git.popCalls).toBe(1);
  });

  it("auto-discards generated files then retries, reporting autoRestoredFiles", async () => {
    const git = makeGit(
      [new Error("would be overwritten"), undefined],
      "src/generated/manifest.json\nsrc/real-work.ts"
    );
    const outcome = await restoreSessionStash("/w", git);
    expect(outcome.restored).toBe(true);
    expect(outcome.autoRestoredFiles).toEqual(["src/generated/manifest.json"]);
    expect(git.checkouts.some((c) => c.includes("src/generated/manifest.json"))).toBe(true);
    expect(git.popCalls).toBe(2);
  });

  it("returns a non-silent parked outcome when the pop cannot be completed", async () => {
    const git = makeGit([new Error("conflict")], "src/a.ts\nsrc/b.ts");
    const outcome = await restoreSessionStash("/w", git);
    expect(outcome.restored).toBe(false);
    expect(outcome.stashRef).toBe("stash@{0}");
    expect(outcome.parkedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(outcome.recovery).toContain("git stash pop");
  });

  it("refuses to pop positionally when another stash was pushed on top of ours", async () => {
    let popCalls = 0;
    const git: StashRestoreGitDeps = {
      async popStash() {
        popCalls++;
        return { workdir: "/w", stashed: true };
      },
      async execInRepository(_workdir: string, command: string) {
        // Our stash (SHA_OURS) is buried at stash@{1}; a newer one sits at @{0}.
        if (command.includes("stash list")) {
          return "stash@{0} SHA_OTHER\nstash@{1} SHA_OURS";
        }
        if (command.includes(STASH_SHOW_CMD)) return "src/work.ts";
        return "";
      },
    };

    const outcome = await restoreSessionStash("/w", git, "SHA_OURS");

    expect(outcome.restored).toBe(false);
    expect(outcome.stashRef).toBe("stash@{1}");
    expect(outcome.parkedFiles).toEqual(["src/work.ts"]);
    expect(outcome.recovery).toContain("git stash pop stash@{1}");
    // Crucially, we never popped — popping @{0} would clobber the wrong stash.
    expect(popCalls).toBe(0);
  });

  it("pops our stash when the SHA confirms it is still on top", async () => {
    let popCalls = 0;
    const git: StashRestoreGitDeps = {
      async popStash() {
        popCalls++;
        return { workdir: "/w", stashed: true };
      },
      async execInRepository(_workdir: string, command: string) {
        if (command.includes("stash list")) return "stash@{0} SHA_OURS";
        if (command.includes(STASH_SHOW_CMD)) return "";
        return "";
      },
    };

    const outcome = await restoreSessionStash("/w", git, "SHA_OURS");

    expect(outcome.restored).toBe(true);
    expect(outcome.stashRef).toBe("stash@{0}");
    expect(popCalls).toBe(1);
  });
});
