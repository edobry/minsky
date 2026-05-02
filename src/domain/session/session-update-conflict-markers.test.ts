/**
 * Regression tests for mt#1367: session_update must leave conflict markers
 * in the working tree when a 3-way merge produces conflicts, so agents can
 * resolve them via session_edit_file / session_search_replace.
 *
 * Background: previously the implementation called `git merge --abort` after
 * detecting conflicts, which wiped the markers from the working tree. The
 * thrown error message said "Edit the conflicted files" but there was nothing
 * to edit — making manual resolution impossible.
 *
 * Fix: removed the `git merge --abort` call from mergeWithConflictPrevention.
 * The merge is left in progress so markers remain visible. The error message
 * now lists the conflicted files and explains how to resolve and commit.
 */

import { describe, it, expect } from "bun:test";
import { updateSessionImpl } from "./session-update-operations";
import { FakeGitService } from "../git/fake-git-service";
import { FakeSessionProvider } from "./fake-session-provider";
import { MinskyError } from "../../errors/index";
import type { SessionRecord } from "./types";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-mt-1367";
const WORKDIR = "/mock/session/workdir";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSessionRecord(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#1367",
    branch: "task/mt-1367",
  };
}

function makeBaseParams(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    remote: "origin",
    noStash: true,
    noPush: true,
    force: false,
    skipConflictCheck: false,
    autoResolveDeleteConflicts: false,
    dryRun: false,
    skipIfAlreadyMerged: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a FakeGitService whose smartSessionUpdate returns a conflict result,
 * simulating a session with changes that conflict with main.
 *
 * The conflictedFiles list represents paths whose working-tree copies contain
 * conflict markers after the failed merge.
 */
function makeConflictingGitService(
  conflictedFiles: string[] = ["src/foo.ts", "src/bar.ts"]
): FakeGitService {
  const svc = new FakeGitService({
    defaultBranch: "task/mt-1367",
    sessionWorkdir: WORKDIR,
  });

  svc.setSmartSessionUpdateResult({
    workdir: WORKDIR,
    updated: false,
    skipped: false,
    reason: "Update failed due to conflicts",
    conflictDetails: "Merge conflicts detected in content files",
    conflictedFiles,
  });

  return svc;
}

/**
 * Build a FakeGitService whose smartSessionUpdate returns a clean happy-path
 * (no conflicts, merge completed).
 */
function makeCleanGitService(): FakeGitService {
  return new FakeGitService({
    defaultBranch: "task/mt-1367",
    sessionWorkdir: WORKDIR,
  });
  // Default FakeGitService.smartSessionUpdate returns { updated: true, skipped: false }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateSessionImpl — conflict marker preservation (mt#1367)", () => {
  it("throws MinskyError that names each conflicted file when merge has conflicts", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const conflictedFiles = ["src/foo.ts", "src/bar.ts"];
    const gitService = makeConflictingGitService(conflictedFiles);

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MinskyError);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);

    // Each conflicted file must appear in the error message
    for (const file of conflictedFiles) {
      expect(msg).toContain(file);
    }
  });

  it("error message tells agent that conflict markers are present in the working tree", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const gitService = makeConflictingGitService(["src/foo.ts"]);

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MinskyError);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);

    // Message must tell the agent that markers are in the working tree
    expect(msg).toContain("<<<<<<<");
  });

  it("error message tells agent to use session_edit_file or session_search_replace", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const gitService = makeConflictingGitService(["src/foo.ts"]);

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MinskyError);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);

    // Message must name the tools to use for resolution
    expect(msg).toMatch(/session_edit_file|session_search_replace/);
  });

  it("error message tells agent to run session_commit after resolving", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const gitService = makeConflictingGitService(["src/foo.ts"]);

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MinskyError);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);

    // Message must tell agent to commit after resolving
    expect(msg).toContain("session_commit");
  });

  it("happy path (no conflicts) completes without throwing and does not push when noPush=true", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const gitService = makeCleanGitService();

    // Must complete without throwing
    await expect(
      updateSessionImpl(makeBaseParams({ noPush: true }), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      })
    ).resolves.toBeDefined();

    // No push invocations when noPush=true
    expect(gitService.pushedCalls).toHaveLength(0);
  });

  it("does not call popStash when merge is in-progress (B2 regression)", async () => {
    // noStash=false means the implementation WOULD call popStash on success.
    // But when a merge is in progress (conflictedFiles present), it must skip popStash
    // because git stash pop is refused or corrupts the working tree during an active merge.
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const conflictedFiles = ["src/foo.ts"];
    const gitService = makeConflictingGitService(conflictedFiles);

    try {
      await updateSessionImpl(
        makeBaseParams({ noStash: false }), // noStash=false: stash would normally be restored
        {
          gitService,
          sessionDB,
          getCurrentSession: async () => undefined,
        }
      );
    } catch {
      // Expected to throw — we only care about whether popStash was called
    }

    // popStash must NOT have been called during the in-progress merge
    expect(gitService.popStashCalls).toHaveLength(0);
  });

  it("autoResolveDeleteConflicts path does not surface conflict markers (delete conflicts are auto-resolved)", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });

    // When autoResolveDeleteConflicts resolves all conflicts, smartSessionUpdate
    // returns an updated=true result with no conflictedFiles
    const gitService = new FakeGitService({
      defaultBranch: "task/mt-1367",
      sessionWorkdir: WORKDIR,
    });
    gitService.setSmartSessionUpdateResult({
      workdir: WORKDIR,
      updated: true,
      skipped: false,
      reason: "Merge update completed",
    });

    // Should not throw
    await expect(
      updateSessionImpl(makeBaseParams({ autoResolveDeleteConflicts: true }), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      })
    ).resolves.toBeDefined();
  });
});
