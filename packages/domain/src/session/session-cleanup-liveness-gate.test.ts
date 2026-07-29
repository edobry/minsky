/**
 * Tests for the mt#3104 live-actor gate in cleanupSessionImpl.
 *
 * Same four-branch verdict handling as the mt#3105 delete gate (ask#6273
 * ruling): live → refuse; inconclusive/store-unavailable → refuse (fail
 * closed); inconclusive/no-claim → abstain; not-live → proceed. Terminal
 * MERGED/CLOSED sessions skip the gate; the shared override lifts a refusal
 * with its own `session-cleanup-liveness` audit event. The former `force`
 * flag is removed — nothing skips the gate (criterion 4, strong form).
 *
 * All in-memory: session workspace directories don't exist on disk, so the
 * git-state loop has nothing to check and no filesystem is touched — the
 * gate itself must still run (the DB-record deletion is destructive too).
 */

import { describe, it, expect, mock } from "bun:test";
import { cleanupSessionImpl } from "./session-lifecycle-operations";
import type { SessionActorResult } from "./session-actor";
import { SessionStatus, type SessionRecord } from "./types";

const SESSION_ID = "mt3104-gate-session";
const TASK_ID = "mt#3104";

function makeRecord(status?: SessionStatus): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoUrl: "https://github.com/edobry/minsky.git",
    repoName: "minsky",
    taskId: TASK_ID,
    createdAt: new Date().toISOString(),
    ...(status ? { status } : {}),
  } as SessionRecord;
}

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

const liveActor = async (): Promise<SessionActorResult> => ({
  verdict: "live",
  reason: "actor test-actor-9 (pid 777, alive) refreshed recently at 2026-07-29T03:00:00.000Z",
  actorId: "test-actor-9",
  lastRefreshedAt: "2026-07-29T03:00:00.000Z",
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

const untaggedInconclusiveActor = async (): Promise<SessionActorResult> => ({
  verdict: "inconclusive",
  reason: "actor x (pid 9, alive) last refreshed at 2026-07-28T10:00:00.000Z",
});

describe("cleanupSessionImpl — mt#3104 live-actor gate", () => {
  it("AT1: refuses cleanup when an actor is live; DB record survives; error names the actor", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID },
      { sessionDB, resolveActor: liveActor }
    );

    expect(result.sessionDeleted).toBe(false);
    expect(result.errors.some((e) => e.includes("test-actor-9"))).toBe(true);
    expect(result.errors.some((e) => e.includes("overrideReason"))).toBe(true);
    expect(sessionDB.deleteSession).not.toHaveBeenCalled();
    expect(await sessionDB.getSession(SESSION_ID)).not.toBeNull();
  });

  it("AT2: refuses cleanup on a store-unavailable inconclusive (fail closed)", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID },
      { sessionDB, resolveActor: storeUnavailableActor }
    );

    expect(result.sessionDeleted).toBe(false);
    expect(sessionDB.deleteSession).not.toHaveBeenCalled();
  });

  it("AT2 (default wiring): with no resolveActor stub and no provider, the real primitive fail-closes", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID },
      { sessionDB }
    );

    expect(result.sessionDeleted).toBe(false);
    expect(result.errors.some((e) => e.includes("presence store unavailable"))).toBe(true);
  });

  it("AT3: proceeds for a not-live session (no-over-fire)", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID },
      { sessionDB, resolveActor: notLiveActor }
    );

    expect(result.sessionDeleted).toBe(true);
    expect(await sessionDB.getSession(SESSION_ID)).toBeNull();
  });

  it("no-claim abstention: a claimless session proceeds (ask#6273 branch 3)", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID },
      { sessionDB, resolveActor: noClaimActor }
    );

    expect(result.sessionDeleted).toBe(true);
  });

  it("an untagged inconclusive refuses — abstention is opt-in on the explicit no-claim cause", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID },
      { sessionDB, resolveActor: untaggedInconclusiveActor }
    );

    expect(result.sessionDeleted).toBe(false);
  });

  it("AT4: MERGED and CLOSED sessions skip the liveness round-trip entirely (the applyPostMergeStateSync path)", async () => {
    for (const status of [SessionStatus.MERGED, SessionStatus.CLOSED]) {
      const sessionDB = makeSessionDB([makeRecord(status)]);
      const actorSpy = mock(liveActor);

      const result = await cleanupSessionImpl(
        { sessionId: SESSION_ID, taskId: TASK_ID },
        { sessionDB, resolveActor: actorSpy }
      );

      expect(actorSpy).not.toHaveBeenCalled();
      expect(result.sessionDeleted).toBe(true);
    }
  });

  it("AT5 (strong form): a NON-terminal live session refuses with no force-style skip available, and the shared override lifts it with a session-cleanup-liveness audit event", async () => {
    const sessionDB = makeSessionDB([makeRecord()]);

    const insertValues = mock(() => Promise.resolve());
    const fakeDb = { insert: () => ({ values: insertValues }) } as any;
    const persistenceProvider = { getDatabaseConnection: async () => fakeDb } as any;

    // Without an override: refused — and `force` no longer exists to pass.
    const refused = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID },
      { sessionDB, resolveActor: liveActor }
    );
    expect(refused.sessionDeleted).toBe(false);

    // With the shared override: proceeds, emitting the liveness audit event.
    const overridden = await cleanupSessionImpl(
      {
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        overrideReason: "operator-confirmed takeover of a wedged session",
      },
      { sessionDB, resolveActor: liveActor, persistenceProvider }
    );

    expect(overridden.sessionDeleted).toBe(true);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.eventType).toBe("guard.overridden");
    expect(row.payload).toMatchObject({
      guard: "session-cleanup-liveness",
      reason: "operator-confirmed takeover of a wedged session",
      verdict: "live",
      actorId: "test-actor-9",
    });
  });
});
