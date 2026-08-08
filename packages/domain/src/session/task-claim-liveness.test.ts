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
import { classifyFreshPeerClaim } from "./task-claim-liveness";
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
