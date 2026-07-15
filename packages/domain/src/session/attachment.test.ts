/**
 * Tests for session runtime-attachment domain layer (mt#2284).
 */

import { describe, test, expect, mock } from "bun:test";
import type { PresenceClaim, PresenceClaimRepository } from "../presence/index";
import {
  listSessionAttachments,
  listAllSessionAttachments,
  clearSessionAttachments,
  isPidAlive,
  reapStaleSessionAttachments,
} from "./attachment";

function makeClaim(overrides: Partial<PresenceClaim> = {}): PresenceClaim {
  return {
    id: "claim-1",
    subjectKind: "session",
    subjectId: "session-a",
    actorId: "actor-1",
    claimedAt: "2026-07-15T00:00:00.000Z",
    lastRefreshedAt: "2026-07-15T00:05:00.000Z",
    ...overrides,
  };
}

function makeFakeRepo(overrides: Partial<PresenceClaimRepository> = {}): PresenceClaimRepository {
  return {
    upsertClaim: mock(async () => makeClaim()),
    listClaims: mock(async () => []),
    reapStale: mock(async () => 0),
    listAllForKind: mock(async () => []),
    deleteBySubject: mock(async () => 0),
    deleteByIds: mock(async () => 0),
    ...overrides,
  };
}

describe("listSessionAttachments", () => {
  test("maps claims to session attachments, mapping lastRefreshedAt to registeredAt", async () => {
    const claim = makeClaim({
      id: "c1",
      pid: 4242,
      tty: "/dev/ttys003",
      host: "myhost",
      ccConversationId: "cc-1",
      entrypoint: "cli",
      terminalContext: { TERM_PROGRAM: "iTerm.app" },
    });
    const repo = makeFakeRepo({
      listClaims: mock(async () => [{ ...claim, stale: false }]),
    });

    const result = await listSessionAttachments(repo, "session-a");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "c1",
      sessionId: "session-a",
      actorId: "actor-1",
      pid: 4242,
      tty: "/dev/ttys003",
      host: "myhost",
      ccConversationId: "cc-1",
      entrypoint: "cli",
      terminalContext: { TERM_PROGRAM: "iTerm.app" },
      registeredAt: claim.lastRefreshedAt,
    });
  });
});

describe("listAllSessionAttachments", () => {
  test("delegates to listAllForKind('session')", async () => {
    const listAllForKind = mock(async () => [makeClaim({ id: "c1" }), makeClaim({ id: "c2" })]);
    const repo = makeFakeRepo({ listAllForKind });

    const result = await listAllSessionAttachments(repo);

    expect(listAllForKind).toHaveBeenCalledWith("session");
    expect(result).toHaveLength(2);
  });
});

describe("clearSessionAttachments", () => {
  test("delegates to deleteBySubject('session', sessionId)", async () => {
    const deleteBySubject = mock(async () => 3);
    const repo = makeFakeRepo({ deleteBySubject });

    const count = await clearSessionAttachments(repo, "session-a");

    expect(deleteBySubject).toHaveBeenCalledWith("session", "session-a");
    expect(count).toBe(3);
  });
});

describe("isPidAlive", () => {
  test("returns true for the current process's own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("returns false for a pid that almost certainly does not exist", () => {
    // PID 4194304+ exceeds Linux/macOS pid_max in practice; treat as dead.
    expect(isPidAlive(999999999)).toBe(false);
  });
});

describe("reapStaleSessionAttachments", () => {
  test("reaps only session-grain attachments whose local pid is confirmed dead", async () => {
    const alive = makeClaim({ id: "alive", pid: process.pid, host: undefined });
    const dead = makeClaim({ id: "dead", pid: 999999999, host: undefined });
    const noPid = makeClaim({ id: "no-pid", pid: undefined, host: undefined });

    const deleteByIds = mock(async (ids: string[]) => ids.length);
    const repo = makeFakeRepo({
      listAllForKind: mock(async () => [alive, dead, noPid]),
      deleteByIds,
    });

    const result = await reapStaleSessionAttachments(repo);

    expect(result.reapedIds).toEqual(["dead"]);
    expect(result.reapedCount).toBe(1);
    expect(result.skippedRemoteHostCount).toBe(0);
    expect(deleteByIds).toHaveBeenCalledWith(["dead"]);
  });

  test("does NOT cover remote-host attachments — skips pid-liveness check and counts them separately", async () => {
    const remote = makeClaim({ id: "remote", pid: 1, host: "some-other-host.example" });
    const deleteByIds = mock(async () => 0);
    const repo = makeFakeRepo({
      listAllForKind: mock(async () => [remote]),
      deleteByIds,
    });

    const result = await reapStaleSessionAttachments(repo);

    expect(result.reapedIds).toEqual([]);
    expect(result.skippedRemoteHostCount).toBe(1);
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  test("does not reap when the list is empty", async () => {
    const deleteByIds = mock(async () => 0);
    const repo = makeFakeRepo({ listAllForKind: mock(async () => []), deleteByIds });

    const result = await reapStaleSessionAttachments(repo);

    expect(result).toEqual({ reapedIds: [], reapedCount: 0, skippedRemoteHostCount: 0 });
    expect(deleteByIds).not.toHaveBeenCalled();
  });
});
