/**
 * mt#5132 — the pure half of the work-package lifecycle sweep.
 *
 * Execution evidence: see PR body. Every fixture is anchored to NOW_MS, never
 * the real clock (testing-standards §The clock is injected).
 */

import { describe, test, expect } from "bun:test";
import {
  CLAIM_STALE_MS,
  conversationIdOfClaim,
  decideClaimRelease,
  decidePackageSweep,
  planPackageLifecycleSweep,
  type SweepPackage,
} from "./work-package-lifecycle-sweep";
import { conversationClaimSuffix } from "./work-package-lifecycle";

const NOW_MS = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 3_600_000;
const CONV = "1d82ba6d-99e8-4d5e-bfb4-d8252aaaaaaa";

describe("decidePackageSweep — criterion 1's predicate", () => {
  test("every member terminal (DONE or CLOSED) → close, naming the members", () => {
    const d = decidePackageSweep([
      { id: "mt#1", status: "DONE" },
      { id: "mt#2", status: "CLOSED" },
      { id: "mt#3", status: "DONE" },
    ]);
    expect(d).toEqual({ action: "close", memberIds: ["mt#1", "mt#2", "mt#3"] });
  });

  test("one open member keeps the package, naming the open ones", () => {
    const d = decidePackageSweep([
      { id: "mt#1", status: "DONE" },
      { id: "mt#2", status: "IN-PROGRESS" },
      { id: "mt#3", status: "TODO" },
    ]);
    expect(d).toEqual({ action: "keep", reason: "open-members", openMembers: ["mt#2", "mt#3"] });
  });

  test("zero members is reported, never closed (AT5)", () => {
    expect(decidePackageSweep([])).toEqual({ action: "keep", reason: "zero-members" });
  });

  test("a member row pointing at a deleted task (null status) is open, not terminal", () => {
    const d = decidePackageSweep([
      { id: "mt#1", status: "DONE" },
      { id: "mt#9", status: null },
    ]);
    expect(d).toEqual({ action: "keep", reason: "open-members", openMembers: ["mt#9"] });
  });
});

describe("decideClaimRelease — criterion 4's predicate, both halves required", () => {
  test("claim 25h old and presence 25h old → release (stale-presence)", () => {
    expect(
      decideClaimRelease({
        claimedAtMs: NOW_MS - 25 * HOUR,
        lastPresenceMs: NOW_MS - 25 * HOUR,
        nowMs: NOW_MS,
      })
    ).toEqual({ action: "release", reason: "stale-presence" });
  });

  test("claim 25h old and NO presence rows → release (no-presence)", () => {
    expect(
      decideClaimRelease({ claimedAtMs: NOW_MS - 25 * HOUR, lastPresenceMs: null, nowMs: NOW_MS })
    ).toEqual({ action: "release", reason: "no-presence" });
  });

  test("claim 25h old but presence 1h ago → keep (presence-fresh)", () => {
    expect(
      decideClaimRelease({
        claimedAtMs: NOW_MS - 25 * HOUR,
        lastPresenceMs: NOW_MS - 1 * HOUR,
        nowMs: NOW_MS,
      })
    ).toEqual({ action: "keep", reason: "presence-fresh" });
  });

  test("claim 2h old with stale presence → keep (claim-fresh): a new holder may not have made a task-bearing call yet", () => {
    expect(
      decideClaimRelease({
        claimedAtMs: NOW_MS - 2 * HOUR,
        lastPresenceMs: NOW_MS - 25 * HOUR,
        nowMs: NOW_MS,
      })
    ).toEqual({ action: "keep", reason: "claim-fresh" });
  });

  test("a legacy claim with no timestamp is kept only by fresh presence", () => {
    expect(
      decideClaimRelease({ claimedAtMs: null, lastPresenceMs: NOW_MS - 1 * HOUR, nowMs: NOW_MS })
    ).toEqual({ action: "keep", reason: "presence-fresh" });
    expect(decideClaimRelease({ claimedAtMs: null, lastPresenceMs: null, nowMs: NOW_MS })).toEqual({
      action: "release",
      reason: "no-presence",
    });
  });

  test("the window is CLAIM_STALE_MS (24h) by default and overridable", () => {
    expect(CLAIM_STALE_MS).toBe(24 * HOUR);
    const args = {
      claimedAtMs: NOW_MS - 3 * HOUR,
      lastPresenceMs: NOW_MS - 3 * HOUR,
      nowMs: NOW_MS,
    };
    expect(decideClaimRelease(args).action).toBe("keep");
    expect(decideClaimRelease({ ...args, staleMs: 2 * HOUR })).toEqual({
      action: "release",
      reason: "stale-presence",
    });
  });
});

describe("planPackageLifecycleSweep — AT1's shape over loaded rows", () => {
  const pkg = (over: Partial<SweepPackage> & { id: string }): SweepPackage => ({
    status: "READY",
    claimedBy: null,
    claimedAtMs: null,
    members: [],
    lastPresenceMs: null,
    ...over,
  });

  test("closes the all-terminal package, keeps the partly-terminal one with the open member named, reports the empty one", () => {
    const plan = planPackageLifecycleSweep(
      [
        pkg({
          id: "mt#100",
          status: "READY",
          members: [
            { id: "mt#1", status: "DONE" },
            { id: "mt#2", status: "CLOSED" },
            { id: "mt#3", status: "DONE" },
          ],
        }),
        pkg({
          id: "mt#101",
          status: "READY",
          members: [
            { id: "mt#4", status: "DONE" },
            { id: "mt#5", status: "DONE" },
            { id: "mt#6", status: "READY" },
          ],
        }),
        pkg({ id: "mt#102", status: "READY", members: [] }),
      ],
      { nowMs: NOW_MS }
    );
    expect(plan.close).toEqual([
      { id: "mt#100", status: "READY", memberIds: ["mt#1", "mt#2", "mt#3"] },
    ]);
    expect(plan.release).toEqual([]);
    expect(plan.keep).toEqual([
      { id: "mt#101", status: "READY", reason: "open-members", detail: ["mt#6"] },
      { id: "mt#102", status: "READY", reason: "zero-members" },
    ]);
    expect(plan.zeroMembers).toEqual(["mt#102"]);
  });

  test("close wins over release: a claimed package whose members all finished is completed, not released", () => {
    const plan = planPackageLifecycleSweep(
      [
        pkg({
          id: "mt#110",
          status: "IN-PROGRESS",
          claimedBy: "com.anthropic.claude-code:proc:abc",
          claimedAtMs: NOW_MS - 48 * HOUR,
          members: [{ id: "mt#1", status: "DONE" }],
        }),
      ],
      { nowMs: NOW_MS }
    );
    expect(plan.close.map((c) => c.id)).toEqual(["mt#110"]);
    expect(plan.release).toEqual([]);
  });

  test("a stale claim on a partly-open package is released with its timestamps; a live one is kept with both reasons", () => {
    const plan = planPackageLifecycleSweep(
      [
        pkg({
          id: "mt#120",
          status: "IN-PROGRESS",
          claimedBy: "com.anthropic.claude-code:proc:dead",
          claimedAtMs: NOW_MS - 48 * HOUR,
          lastPresenceMs: NOW_MS - 47 * HOUR,
          members: [{ id: "mt#1", status: "TODO" }],
        }),
        pkg({
          id: "mt#121",
          status: "IN-PROGRESS",
          claimedBy: `com.anthropic.claude-code${conversationClaimSuffix(CONV)}`,
          claimedAtMs: NOW_MS - 48 * HOUR,
          lastPresenceMs: NOW_MS - 10 * 60_000,
          members: [{ id: "mt#2", status: "TODO" }],
        }),
      ],
      { nowMs: NOW_MS }
    );
    expect(plan.release).toEqual([
      {
        id: "mt#120",
        claimedBy: "com.anthropic.claude-code:proc:dead",
        claimedAt: new Date(NOW_MS - 48 * HOUR).toISOString(),
        lastPresenceAt: new Date(NOW_MS - 47 * HOUR).toISOString(),
        reason: "stale-presence",
      },
    ]);
    expect(plan.keep).toEqual([
      {
        id: "mt#121",
        status: "IN-PROGRESS",
        reason: "open-members; presence-fresh",
        detail: ["mt#2"],
      },
    ]);
  });

  test("a READY package is never a release candidate, whatever its rows say", () => {
    const plan = planPackageLifecycleSweep(
      [
        pkg({
          id: "mt#130",
          status: "READY",
          claimedBy: "stale-leftover",
          claimedAtMs: NOW_MS - 100 * HOUR,
          members: [{ id: "mt#1", status: "TODO" }],
        }),
      ],
      { nowMs: NOW_MS }
    );
    expect(plan.release).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("open-members");
  });
});

describe("conversation identity matching (criterion 3)", () => {
  test("conversationIdOfClaim reads the :conv: tail, including under a subagent parent", () => {
    expect(conversationIdOfClaim(`com.anthropic.claude-code:conv:${CONV}`)).toBe(CONV);
    expect(
      conversationIdOfClaim(
        `minsky.native-subagent:task:mt#1@com.anthropic.claude-code:conv:${CONV}`
      )
    ).toBe(CONV);
  });

  test("a proc: id, free text, or null yields no conversation — those claims are the sweep's, never the hook's", () => {
    expect(conversationIdOfClaim("com.anthropic.claude-code:proc:b0677f009dc6a76b")).toBeNull();
    expect(
      conversationIdOfClaim("claude-code conversation 8fc6653a-c57f-4950-a174-dc4484c1559")
    ).toBeNull();
    expect(conversationIdOfClaim(null)).toBeNull();
  });

  test("the suffix the release matches on is exactly :conv:<id>", () => {
    expect(conversationClaimSuffix(CONV)).toBe(`:conv:${CONV}`);
  });
});
