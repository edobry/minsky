/**
 * Tests for mt#4164's sweep-time calibration claims.
 *
 * The cases mirror the R3 incident that produced the mechanism: two passes over
 * one window, one minute apart, the second unable to see the first because the
 * first had produced no artifact yet.
 */

import { describe, expect, test } from "bun:test";
import {
  CLAIM_STALE_MS,
  annotateClaim,
  blockingClaims,
  describeBlockingClaims,
  logsToActOn,
  pruneStaleClaims,
  releaseClaims,
  withClaims,
  type CalibrationClaim,
  type CalibrationClaimStore,
} from "./calibration-claims";

const LOG_A = ".minsky/bare-entity-ref-calibration.jsonl";
const LOG_B = ".minsky/code-mechanism-assertion-calibration.jsonl";
const ME = "conv:aaaa";
const OTHER = "conv:bbbb";

const T0 = Date.parse("2026-08-16T21:24:00.000Z");
const ISO_T0 = new Date(T0).toISOString();

function storeWith(logPath: string, actorId: string, atMs: number): CalibrationClaimStore {
  const iso = new Date(atMs).toISOString();
  return { [logPath]: { actorId, claimedAt: iso, lastRefreshedAt: iso } };
}

/** The claim `storeWith` just put at `logPath` — total, so no `!` at call sites. */
function claimAt(store: CalibrationClaimStore, logPath: string): CalibrationClaim {
  const claim = store[logPath];
  if (!claim) throw new Error(`fixture missing a claim at ${logPath}`);
  return claim;
}

describe("annotateClaim", () => {
  test("a just-taken claim is fresh", () => {
    const annotated = annotateClaim(LOG_A, claimAt(storeWith(LOG_A, OTHER, T0), LOG_A), T0 + 1000);
    expect(annotated.stale).toBe(false);
    expect(annotated.ageMs).toBe(1000);
    expect(annotated.logPath).toBe(LOG_A);
  });

  test("a claim past the threshold is stale", () => {
    const annotated = annotateClaim(
      LOG_A,
      claimAt(storeWith(LOG_A, OTHER, T0), LOG_A),
      T0 + CLAIM_STALE_MS + 1
    );
    expect(annotated.stale).toBe(true);
  });

  test("an unparseable timestamp reads as stale, not fresh", () => {
    // Failing toward "someone holds this" would deadlock every later pass on one
    // corrupt record; the other direction costs at most a duplicated pass.
    const annotated = annotateClaim(
      LOG_A,
      { actorId: OTHER, claimedAt: "not-a-date", lastRefreshedAt: "not-a-date" },
      T0
    );
    expect(annotated.stale).toBe(true);
    expect(annotated.ageMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("blockingClaims — the R3 case", () => {
  test("another actor's fresh claim blocks", () => {
    // The pass that filed one minute later should have seen this.
    const store = storeWith(LOG_A, OTHER, T0);
    const blocking = blockingClaims(store, [LOG_A], ME, T0 + 60_000);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.actorId).toBe(OTHER);
    expect(blocking[0]?.logPath).toBe(LOG_A);
  });

  test("my own claim never blocks me", () => {
    // Re-running a sweep mid-pass must not lock the runner out of its own work.
    const store = storeWith(LOG_A, ME, T0);
    expect(blockingClaims(store, [LOG_A], ME, T0 + 60_000)).toEqual([]);
  });

  test("another actor's STALE claim does not block", () => {
    const store = storeWith(LOG_A, OTHER, T0);
    expect(blockingClaims(store, [LOG_A], ME, T0 + CLAIM_STALE_MS + 1)).toEqual([]);
  });

  test("only the requested paths are considered", () => {
    const store = storeWith(LOG_B, OTHER, T0);
    expect(blockingClaims(store, [LOG_A], ME, T0 + 1000)).toEqual([]);
  });

  test("an unclaimed log does not block", () => {
    expect(blockingClaims({}, [LOG_A, LOG_B], ME, T0)).toEqual([]);
  });
});

describe("blockingClaims — an unidentifiable pass still SEES others' claims (mt#4408)", () => {
  test("a null actorId is blocked by another actor's fresh claim", () => {
    const store = storeWith(LOG_A, OTHER, T0);
    const blocking = blockingClaims(store, [LOG_A], null, T0 + 60_000);
    expect(blocking.map((c) => c.logPath)).toEqual([LOG_A]);
    expect(blocking[0]?.actorId).toBe(OTHER);
  });

  test("a null actorId excludes nothing — every fresh claim is someone else's", () => {
    // The R4 shape: the losing pass could not name itself, so it holds no
    // claims and has no self to filter out. Both logs must come back blocking.
    const store: CalibrationClaimStore = {
      ...storeWith(LOG_A, OTHER, T0),
      ...storeWith(LOG_B, ME, T0),
    };
    expect(blockingClaims(store, [LOG_A, LOG_B], null, T0 + 60_000).map((c) => c.logPath)).toEqual([
      LOG_A,
      LOG_B,
    ]);
    // Control: a pass that CAN name itself as ME still filters its own.
    expect(blockingClaims(store, [LOG_A, LOG_B], ME, T0 + 60_000).map((c) => c.logPath)).toEqual([
      LOG_A,
    ]);
  });

  test("staleness still applies to a null actorId — an expired claim blocks nobody", () => {
    const store = storeWith(LOG_A, OTHER, T0);
    expect(blockingClaims(store, [LOG_A], null, T0 + CLAIM_STALE_MS + 1)).toEqual([]);
  });
});

describe("withClaims", () => {
  test("takes a claim on each requested path", () => {
    const next = withClaims({}, [LOG_A, LOG_B], ME, ISO_T0);
    expect(next[LOG_A]?.actorId).toBe(ME);
    expect(next[LOG_B]?.actorId).toBe(ME);
    expect(next[LOG_A]?.claimedAt).toBe(ISO_T0);
  });

  test("refreshing my own claim preserves claimedAt so pass duration stays readable", () => {
    const later = new Date(T0 + 120_000).toISOString();
    const next = withClaims(storeWith(LOG_A, ME, T0), [LOG_A], ME, later);
    expect(next[LOG_A]?.claimedAt).toBe(ISO_T0);
    expect(next[LOG_A]?.lastRefreshedAt).toBe(later);
  });

  test("taking over a stale holder resets claimedAt, so the takeover is visible", () => {
    const later = new Date(T0 + CLAIM_STALE_MS + 1).toISOString();
    const next = withClaims(storeWith(LOG_A, OTHER, T0), [LOG_A], ME, later);
    expect(next[LOG_A]?.actorId).toBe(ME);
    expect(next[LOG_A]?.claimedAt).toBe(later);
  });

  test("does not mutate the input store", () => {
    const store = storeWith(LOG_A, OTHER, T0);
    withClaims(store, [LOG_A], ME, ISO_T0);
    expect(store[LOG_A]?.actorId).toBe(OTHER);
  });
});

describe("releaseClaims", () => {
  test("drops my claim on ack", () => {
    expect(releaseClaims(storeWith(LOG_A, ME, T0), [LOG_A], ME)).toEqual({});
  });

  test("never drops another actor's claim", () => {
    // A losing pass must not unlock the winner mid-work.
    const store = storeWith(LOG_A, OTHER, T0);
    expect(releaseClaims(store, [LOG_A], ME)).toEqual(store);
  });

  test("releasing a path I do not hold is a no-op, not an error", () => {
    expect(releaseClaims({}, [LOG_A], ME)).toEqual({});
  });
});

describe("pruneStaleClaims", () => {
  test("drops aged-out claims regardless of holder and keeps fresh ones", () => {
    const store: CalibrationClaimStore = {
      ...storeWith(LOG_A, OTHER, T0),
      ...storeWith(LOG_B, ME, T0 + CLAIM_STALE_MS),
    };
    const pruned = pruneStaleClaims(store, T0 + CLAIM_STALE_MS + 1);
    expect(Object.keys(pruned)).toEqual([LOG_B]);
  });

  test("changes no blocking decision — a pruned claim was already ignored", () => {
    const store = storeWith(LOG_A, OTHER, T0);
    const at = T0 + CLAIM_STALE_MS + 1;
    expect(blockingClaims(pruneStaleClaims(store, at), [LOG_A], ME, at)).toEqual(
      blockingClaims(store, [LOG_A], ME, at)
    );
  });
});

describe("logsToActOn — the ack must not be gated by claims (PR #3015 R1)", () => {
  const due = [{ path: LOG_A }, { path: LOG_B }];
  const pathOf = (d: { path: string }) => d.path;

  test("a READ pass drops the log another actor is working on", () => {
    expect(logsToActOn(due, [LOG_A], false, pathOf)).toEqual([{ path: LOG_B }]);
  });

  test("an ACK pass keeps it — the receipt says what was READ, not who is working", () => {
    // The defect this replaces: a pass that legitimately classified LOG_A could
    // not RECORD that, because someone else started working on it in between,
    // silently discarding real review work.
    expect(logsToActOn(due, [LOG_A], true, pathOf)).toEqual(due);
  });

  test("no claims means no filtering, on either path", () => {
    expect(logsToActOn(due, [], false, pathOf)).toEqual(due);
    expect(logsToActOn(due, [], true, pathOf)).toEqual(due);
  });

  test("does not mutate the input", () => {
    const input = [...due];
    logsToActOn(input, [LOG_A], false, pathOf);
    expect(input).toHaveLength(2);
  });
});

describe("describeBlockingClaims", () => {
  test("names the holder and the age so the standing-down pass can report it", () => {
    const blocking = blockingClaims(storeWith(LOG_A, OTHER, T0), [LOG_A], ME, T0 + 65_000);
    const [line] = describeBlockingClaims(blocking);
    expect(line).toContain(LOG_A);
    expect(line).toContain(OTHER);
    expect(line).toContain("65s ago");
    expect(line).toContain("stand down");
  });
});
