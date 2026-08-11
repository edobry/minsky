/**
 * Unit tests for the task-claim-liveness pure classifier (mt#3121).
 *
 * Covers `classifyFreshPeerClaim` — the functional core that decides
 * `contested` vs `no-fresh-claim` from an already-fetched claim list. The I/O
 * shell (`resolveTaskClaimLiveness`) and the four-branch wiring into the
 * recover command are exercised through the command's injected `taskClaimOps`
 * seam in dispatch-recover-command.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { classifyFreshPeerClaim, resolveTaskClaimLiveness } from "./task-claim-liveness";
import type { TaskClaimProvider } from "./task-claim-liveness";
import type { AnnotatedPresenceClaim } from "../presence/types";

const CALLER = "com.anthropic.claude-code:conv:caller-aaaa";
const PEER = "com.anthropic.claude-code:conv:peer-bbbb";
const REFRESHED = "2026-08-05T20:16:50.000Z";

function claim(
  over: Partial<AnnotatedPresenceClaim> & { actorId: string; stale: boolean }
): AnnotatedPresenceClaim {
  return {
    id: over.id ?? `claim-${over.actorId}`,
    subjectKind: "task",
    subjectId: "mt3121",
    actorId: over.actorId,
    claimedAt: over.claimedAt ?? REFRESHED,
    lastRefreshedAt: over.lastRefreshedAt ?? REFRESHED,
    stale: over.stale,
  };
}

describe("classifyFreshPeerClaim", () => {
  test("a fresh claim from a different actor is contested, surfacing the peer", () => {
    const result = classifyFreshPeerClaim([claim({ actorId: PEER, stale: false })], CALLER);
    expect(result.cause).toBe("contested");
    expect(result.peerActorId).toBe(PEER);
    expect(result.peerLastRefreshedAt).toBe(REFRESHED);
  });

  test("only the caller's own fresh claim is not contested (self excluded — SC4)", () => {
    const result = classifyFreshPeerClaim([claim({ actorId: CALLER, stale: false })], CALLER);
    expect(result.cause).toBe("no-fresh-claim");
    expect(result.peerActorId).toBeUndefined();
  });

  test("a stale peer claim is not contested", () => {
    const result = classifyFreshPeerClaim([claim({ actorId: PEER, stale: true })], CALLER);
    expect(result.cause).toBe("no-fresh-claim");
  });

  test("a fresh caller claim alongside a fresh peer claim resolves to the peer, not the caller", () => {
    const result = classifyFreshPeerClaim(
      [claim({ actorId: CALLER, stale: false }), claim({ actorId: PEER, stale: false })],
      CALLER
    );
    expect(result.cause).toBe("contested");
    expect(result.peerActorId).toBe(PEER);
  });

  test("no claims at all is not contested", () => {
    expect(classifyFreshPeerClaim([], CALLER).cause).toBe("no-fresh-claim");
  });

  test("a null callerActorId excludes nothing — any fresh claim counts as a peer", () => {
    const result = classifyFreshPeerClaim([claim({ actorId: PEER, stale: false })], null);
    expect(result.cause).toBe("contested");
    expect(result.peerActorId).toBe(PEER);
  });
});

// ---------------------------------------------------------------------------
// resolveTaskClaimLiveness (I/O shell) — mt#3958
//
// Before mt#3958, every one of these "could not look" conditions returned the
// SAME value a genuinely-empty read returns (`no-fresh-claim`), so a caller
// could not fail closed even if it wanted to (dispatch-recover-command.ts's
// mt#3812 double-dispatch). These tests pin the corrected `unavailable` +
// `unavailableReason` shape directly on the I/O shell, one level below the
// command's injected `taskClaimLiveness` seam that dispatch-recover-command.
// test.ts exercises.
// ---------------------------------------------------------------------------
describe("resolveTaskClaimLiveness (I/O shell, mt#3958)", () => {
  const LOG_CONTEXT = { source: "test" };

  test("no provider at all -> unavailable/no-provider (the ROUTINE persistence-less case)", async () => {
    const result = await resolveTaskClaimLiveness("mt#3958", CALLER, undefined, LOG_CONTEXT);
    expect(result.cause).toBe("unavailable");
    expect(result.unavailableReason).toBe("no-provider");
  });

  test("a provider with no getDatabaseConnection accessor -> unavailable/no-provider", async () => {
    const provider = {} as TaskClaimProvider;
    const result = await resolveTaskClaimLiveness("mt#3958", CALLER, provider, LOG_CONTEXT);
    expect(result.cause).toBe("unavailable");
    expect(result.unavailableReason).toBe("no-provider");
  });

  test("getDatabaseConnection() resolves no connection -> unavailable/no-connection", async () => {
    const provider: TaskClaimProvider = { getDatabaseConnection: async () => null };
    const result = await resolveTaskClaimLiveness("mt#3958", CALLER, provider, LOG_CONTEXT);
    expect(result.cause).toBe("unavailable");
    expect(result.unavailableReason).toBe("no-connection");
  });

  test("an unnormalizable task id -> unavailable/invalid-subject, without querying the repo", async () => {
    // A truthy db is enough to pass buildPresenceClaimRepository (it only
    // guards `!db`) — normalizeTaskSubjectId("") short-circuits before any
    // repo method is ever called, so this db stub is never touched.
    const provider: TaskClaimProvider = { getDatabaseConnection: async () => ({}) };
    const result = await resolveTaskClaimLiveness("", CALLER, provider, LOG_CONTEXT);
    expect(result.cause).toBe("unavailable");
    expect(result.unavailableReason).toBe("invalid-subject");
  });

  test("getDatabaseConnection() throwing -> read-failure (fail-closed, unchanged by mt#3958)", async () => {
    const provider: TaskClaimProvider = {
      getDatabaseConnection: async () => {
        throw new Error("connection refused");
      },
    };
    const result = await resolveTaskClaimLiveness("mt#3958", CALLER, provider, LOG_CONTEXT);
    expect(result.cause).toBe("read-failure");
    expect(result.unavailableReason).toBeUndefined();
  });
});
