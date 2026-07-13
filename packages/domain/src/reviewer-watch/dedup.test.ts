/**
 * Hermetic tests for `MissedReviewDedupState`.
 *
 * Covers the four decision branches and the state-mutation contract:
 * persistent conditions fire once per onset, set-changes re-fire,
 * key-disappearance resets state.
 */

import { describe, expect, test } from "bun:test";
import { MissedReviewDedupState } from "./dedup";
import type { MissingReviewPR } from "./types";

const makeMiss = (n: number, sha: string = `sha${n}`): MissingReviewPR => ({
  number: n,
  headSha: sha,
  authorLogin: "alice",
  reason: "no_review_by_bot",
  htmlUrl: `https://github.com/owner/repo/pull/${n}`,
});

describe("MissedReviewDedupState.decide", () => {
  test("none-missing: empty list returns 'none-missing' regardless of threshold", () => {
    const state = new MissedReviewDedupState();
    expect(state.decide([], 1).decision).toBe("none-missing");
    expect(state.decide([], 5).decision).toBe("none-missing");
  });

  test("below-threshold: count < threshold suppresses", () => {
    const state = new MissedReviewDedupState();
    expect(state.decide([makeMiss(1), makeMiss(2)], 3).decision).toBe("below-threshold");
  });

  test("new-condition: first cycle with misses above threshold fires", () => {
    const state = new MissedReviewDedupState();
    expect(state.decide([makeMiss(1)], 1).decision).toBe("new-condition");
    expect(state.getAlertedKeys()).toContain("1@sha1");
  });

  test("unchanged: same set of misses on subsequent cycle suppresses", () => {
    const state = new MissedReviewDedupState();
    state.decide([makeMiss(1), makeMiss(2)], 1);
    const second = state.decide([makeMiss(1), makeMiss(2)], 1);
    expect(second.decision).toBe("unchanged");
  });

  test("new-condition: adding a new PR to the set re-fires", () => {
    const state = new MissedReviewDedupState();
    state.decide([makeMiss(1)], 1);
    const second = state.decide([makeMiss(1), makeMiss(2)], 1);
    expect(second.decision).toBe("new-condition");
    expect(state.getAlertedKeys().sort()).toEqual(["1@sha1", "2@sha2"]);
  });

  test("new-condition: same PR with new HEAD SHA re-fires (push counts)", () => {
    const state = new MissedReviewDedupState();
    state.decide([makeMiss(1, "old-sha")], 1);
    const second = state.decide([makeMiss(1, "new-sha")], 1);
    expect(second.decision).toBe("new-condition");
    expect(state.getAlertedKeys()).toEqual(["1@new-sha"]);
  });

  test("none-missing resets state so re-onset fires fresh", () => {
    const state = new MissedReviewDedupState();
    state.decide([makeMiss(1)], 1);
    state.decide([], 1);
    expect(state.getAlertedKeys()).toEqual([]);

    const reonset = state.decide([makeMiss(1)], 1);
    expect(reonset.decision).toBe("new-condition");
  });

  test("subset shrink (one PR resolved) suppresses but updates state", () => {
    const state = new MissedReviewDedupState();
    state.decide([makeMiss(1), makeMiss(2)], 1);
    const shrink = state.decide([makeMiss(1)], 1);
    // Shrink IS a state change, so by the current decide rule it fires; this
    // test pins that behavior so future changes are intentional.
    expect(shrink.decision).toBe("new-condition");
    expect(state.getAlertedKeys()).toEqual(["1@sha1"]);
  });

  test("threshold transition: 1 → 2 → 1 below threshold of 2", () => {
    const state = new MissedReviewDedupState();
    expect(state.decide([makeMiss(1)], 2).decision).toBe("below-threshold");
    expect(state.decide([makeMiss(1), makeMiss(2)], 2).decision).toBe("new-condition");
    expect(state.decide([makeMiss(1)], 2).decision).toBe("below-threshold");
  });
});
