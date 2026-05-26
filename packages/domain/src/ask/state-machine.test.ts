/**
 * Tests for state-machine module — focused on the SoT invariants:
 * `TERMINAL_ASK_STATES` is derived from `isTerminal` and `ALL_ASK_STATES`
 * is the runtime-exhaustive list of every AskState.
 *
 * The transition table itself is exercised indirectly via `repository.test.ts`
 * (which calls `repo.transition` for the full happy path + invalid moves).
 */

import { describe, it, expect } from "bun:test";
import type { AskState } from "./types";
import {
  ALL_ASK_STATES,
  TERMINAL_ASK_STATES,
  VALID_TRANSITIONS,
  isTerminal,
  guardTransition,
  InvalidAskTransitionError,
} from "./state-machine";

describe("ALL_ASK_STATES", () => {
  it("includes every AskState union member exactly once", () => {
    // Listed here to fail the test if a new state is added without
    // touching this assertion. The Record<AskState, true> guard inside
    // state-machine.ts already forces this at compile time; this test
    // is the runtime mirror.
    const expected: readonly AskState[] = [
      "detected",
      "classified",
      "routed",
      "suspended",
      "responded",
      "closed",
      "cancelled",
      "expired",
    ];
    expect([...ALL_ASK_STATES].sort()).toEqual([...expected].sort());
  });
});

describe("TERMINAL_ASK_STATES", () => {
  it("is exactly the set of states for which isTerminal(state) === true", () => {
    // SoT invariant — TERMINAL_ASK_STATES must agree with isTerminal()
    // for every AskState. If they ever drift, this test fires.
    const fromPredicate = ALL_ASK_STATES.filter(isTerminal);
    expect([...TERMINAL_ASK_STATES].sort()).toEqual([...fromPredicate].sort());
  });

  it("contains closed, cancelled, expired", () => {
    // Spot-check the known terminal states in case the predicate itself
    // is broken — protects against silent classification flips.
    expect(TERMINAL_ASK_STATES).toContain("closed");
    expect(TERMINAL_ASK_STATES).toContain("cancelled");
    expect(TERMINAL_ASK_STATES).toContain("expired");
  });

  it("does not contain non-terminal states", () => {
    expect(TERMINAL_ASK_STATES).not.toContain("detected");
    expect(TERMINAL_ASK_STATES).not.toContain("classified");
    expect(TERMINAL_ASK_STATES).not.toContain("routed");
    expect(TERMINAL_ASK_STATES).not.toContain("suspended");
    expect(TERMINAL_ASK_STATES).not.toContain("responded");
  });
});

describe("guardTransition", () => {
  it("returns the target state when the move is valid", () => {
    expect(guardTransition("detected", "classified")).toBe("classified");
  });

  it("throws InvalidAskTransitionError when the move is not in the table", () => {
    expect(() => guardTransition("closed", "detected")).toThrow(InvalidAskTransitionError);
  });
});

describe("VALID_TRANSITIONS", () => {
  // SoT invariant — VALID_TRANSITIONS must have an entry for every AskState
  // (including terminals, which map to an empty set). Per PR #930 R3
  // BLOCKING fix: previously `buildValidTransitions` had a local `states`
  // array that could silently drift from the union; now it iterates
  // `ALL_ASK_STATES`. This test pins the invariant in case the iteration
  // source is ever changed.
  it("has an entry for every AskState (no missing keys)", () => {
    const transitionKeys = [...VALID_TRANSITIONS.keys()].sort();
    const allStates = [...ALL_ASK_STATES].sort();
    expect(transitionKeys).toEqual(allStates);
  });

  it("terminal states map to an empty allowed-set (closed/cancelled/expired)", () => {
    for (const terminal of TERMINAL_ASK_STATES) {
      expect(VALID_TRANSITIONS.get(terminal)?.size).toBe(0);
    }
  });
});
