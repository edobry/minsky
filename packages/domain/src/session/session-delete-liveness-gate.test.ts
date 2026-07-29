/**
 * Tests for the mt#3105 live-actor gate in deleteSessionImpl.
 *
 * Verdict handling per the ask#6273 operator ruling (spec §Resolution,
 * mem#749):
 *   live                              → refuse (names actor + last activity)
 *   inconclusive / store-unavailable  → refuse (fail closed)
 *   inconclusive / no-claim           → abstain (git-state guard decides)
 *   inconclusive / untagged cause     → refuse (abstention is opt-in)
 *   not-live                          → proceed
 * Terminal-state sessions (MERGED/CLOSED) skip the gate entirely, and the
 * shared override contract lifts a refusal with its own audit event.
 *
 * Everything is in-memory: fs and gitService are stubbed, so no real
 * workspace directories are touched.
 */

import { describe, it, expect, mock } from "bun:test";
import { deleteSessionImpl } from "./session-lifecycle-operations";
import type { SessionActorResult } from "./session-actor";
import { SessionStatus, type SessionRecord } from "./types";
import type { GitServiceInterface } from "../git/types";
import { getSessionsDir } from "@minsky/shared/paths";

const SESSION_ID = "mt3105-gate-session";

function workspaceDirFor(sessionId: string): string {
  return `${getSessionsDir()}/${sessionId}`;
}

function makeRecord(status?: SessionStatus): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoUrl: "https://github.com/edobry/minsky.git",
    repoName: "minsky",
    taskId: "mt#3105",
    createdAt: new Date().toISOString(),
    ...(status ? { status } : {}),
  } as SessionRecord;
}

/** Minimal in-memory session provider sufficient for deleteSessionImpl. */
function makeSessionDB(sessions: SessionRecord[]) {
  const store = new Map(sessions.map((s) => [s.sessionId, s]));
  return {
    getSession: mock(async (id: string) => store.get(id) ?? null),
    getSessionByTaskId: mock(async () => null),
    listSessions: mock(async () => Array.from(store.values())),
    addSession: mock(async () => {}),
    updateSession: mock(async () => {}),
    deleteSession: mock(async (id: string) => {
      const existed = store.has(id);
      store.delete(id);
      return existed;
    }),
    getRepoPath: mock(async () => "/mock/repo"),
    getSessionWorkdir: mock(async (id: string) => `/mock/sessions/${id}`),
  };
}

/** fs stub: the workspace dir "exists"; nothing else (so MERGE_HEAD reads absent). */
function makeFs(rmSpy = mock(() => {})) {
  return {
    fs: {
      existsSync: (p: unknown) => p === workspaceDirFor(SESSION_ID),
      rmSync: rmSpy,
    },
    rmSpy,
  };
}

/** gitService stub covering exactly what deleteSessionImpl consults. */
function makeGit(dirty: boolean): GitServiceInterface {
  return {
    hasUncommittedChanges: async () => dirty,
    execInRepository: async () => "",
  } as unknown as GitServiceInterface;
}

const liveActor = async (): Promise<SessionActorResult> => ({
  verdict: "live",
  reason: "actor test-actor-7 (pid 4242, alive) refreshed recently at 2026-07-28T22:00:00.000Z",
  actorId: "test-actor-7",
  lastRefreshedAt: "2026-07-28T22:00:00.000Z",
});

const notLiveActor = async (): Promise<SessionActorResult> => ({
  verdict: "not-live",
  reason: "actor gone (pid 1, dead) last refreshed at 2026-07-01T00:00:00.000Z",
});

const storeUnavailableActor = async (): Promise<SessionActorResult> => ({
  verdict: "inconclusive",
  cause: "store-unavailable",
  reason: "presence read failed (simulated) — cannot establish whether an actor is live",
});

const noClaimActor = async (): Promise<SessionActorResult> => ({
  verdict: "inconclusive",
  cause: "no-claim",
  reason: "no presence claim on record for this session",
});

/** Untagged inconclusive — e.g. a claim-derived gray state. Must refuse. */
const untaggedInconclusiveActor = async (): Promise<SessionActorResult> => ({
  verdict: "inconclusive",
  reason: "actor x (pid 9, alive) last refreshed at 2026-07-28T10:00:00.000Z",
});

describe("deleteSessionImpl — mt#3105 live-actor gate", () => {
  it("AT1: refuses when an actor is live; workspace and DB record survive; refusal names the actor and its last activity", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);
    const { fs, rmSpy } = makeFs();

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID },
      { sessionDB, gitService: makeGit(false), fs, resolveActor: liveActor }
    );

    expect(result.deleted).toBe(false);
    // SC2: the refusal names the holding actor and its last observed activity.
    expect(result.error).toContain("test-actor-7");
    expect(result.error).toContain("2026-07-28T22:00:00.000Z");
    expect(result.error).toContain("overrideReason");
    expect(rmSpy).not.toHaveBeenCalled();
    expect(await sessionDB.getSession(SESSION_ID)).not.toBeNull();
  });

  it("AT2: refuses when the presence store cannot be read (fail closed)", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);
    const { fs, rmSpy } = makeFs();

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID },
      { sessionDB, gitService: makeGit(false), fs, resolveActor: storeUnavailableActor }
    );

    expect(result.deleted).toBe(false);
    expect(rmSpy).not.toHaveBeenCalled();
    expect(await sessionDB.getSession(SESSION_ID)).not.toBeNull();
  });

  it("AT2 (default wiring): with no resolveActor stub and no persistence provider, the real primitive fail-closes end-to-end", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);
    const { fs, rmSpy } = makeFs();

    // No resolveActor, no persistenceProvider: the default path builds the
    // real resolveSessionActor with a null repository → store-unavailable.
    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID },
      { sessionDB, gitService: makeGit(false), fs }
    );

    expect(result.deleted).toBe(false);
    expect(result.error).toContain("presence store unavailable");
    expect(rmSpy).not.toHaveBeenCalled();
  });

  it("AT3: proceeds for a not-live session (no-over-fire)", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);
    const { fs, rmSpy } = makeFs();

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID },
      { sessionDB, gitService: makeGit(false), fs, resolveActor: notLiveActor }
    );

    expect(result.deleted).toBe(true);
    expect(rmSpy).toHaveBeenCalled();
    expect(await sessionDB.getSession(SESSION_ID)).toBeNull();
  });

  it("AT4: MERGED and CLOSED sessions skip the liveness round-trip entirely", async () => {
    for (const status of [SessionStatus.MERGED, SessionStatus.CLOSED]) {
      const sessionDB = makeSessionDB([makeRecord(status)]);
      const { fs } = makeFs();
      const actorSpy = mock(liveActor);

      const result = await deleteSessionImpl(
        { sessionId: SESSION_ID },
        { sessionDB, gitService: makeGit(false), fs, resolveActor: actorSpy }
      );

      // The primitive is not consulted — even a would-be-live actor cannot
      // block a terminal session's delete.
      expect(actorSpy).not.toHaveBeenCalled();
      expect(result.deleted).toBe(true);
    }
  });

  it("AT5: the shared override lifts a live refusal and records a session-delete-liveness audit event", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);
    const { fs } = makeFs();

    const insertValues = mock(() => Promise.resolve());
    const fakeDb = { insert: () => ({ values: insertValues }) } as any;
    const persistenceProvider = { getDatabaseConnection: async () => fakeDb } as any;

    const result = await deleteSessionImpl(
      {
        sessionId: SESSION_ID,
        overrideReason: "operator-confirmed takeover of a wedged session",
      },
      {
        sessionDB,
        gitService: makeGit(false),
        fs,
        persistenceProvider,
        resolveActor: liveActor,
      }
    );

    expect(result.deleted).toBe(true);
    // Clean tree → git-state passes → exactly one guard (liveness) tripped.
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.eventType).toBe("guard.overridden");
    expect(row.payload).toMatchObject({
      guard: "session-delete-liveness",
      reason: "operator-confirmed takeover of a wedged session",
      verdict: "live",
      actorId: "test-actor-7",
    });
  });

  it("no-claim abstention: a claimless session with a CLEAN tree proceeds (ask#6273 branch 3)", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);
    const { fs, rmSpy } = makeFs();

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID },
      { sessionDB, gitService: makeGit(false), fs, resolveActor: noClaimActor }
    );

    expect(result.deleted).toBe(true);
    expect(rmSpy).toHaveBeenCalled();
  });

  it("no-claim abstention is NOT exemption: a claimless session with a DIRTY tree is still refused by the git-state guard", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);
    const { fs, rmSpy } = makeFs();
    const actorSpy = mock(noClaimActor);

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID },
      { sessionDB, gitService: makeGit(true), fs, resolveActor: actorSpy }
    );

    expect(result.deleted).toBe(false);
    expect(result.error).toContain("uncommitted changes");
    expect(rmSpy).not.toHaveBeenCalled();
    // The git-state guard refuses first; the liveness gate is never reached.
    expect(actorSpy).not.toHaveBeenCalled();
  });

  it("an untagged inconclusive verdict refuses — abstention is opt-in on the explicit no-claim cause", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);
    const { fs, rmSpy } = makeFs();

    const result = await deleteSessionImpl(
      { sessionId: SESSION_ID },
      { sessionDB, gitService: makeGit(false), fs, resolveActor: untaggedInconclusiveActor }
    );

    expect(result.deleted).toBe(false);
    expect(rmSpy).not.toHaveBeenCalled();
  });
});
