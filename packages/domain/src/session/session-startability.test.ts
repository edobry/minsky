/**
 * Unit tests for session-start startability (mt#2959).
 *
 * Covers the two behaviors the cockpit "Start session" defect exposed:
 *   1. sessionStartBlockedReason names the ACTUAL kind-aware precursor
 *      (implementation → READY, umbrella → PLANNING) — not a first-of-two-gates
 *      "set PLANNING" that an implementation task bounces off of.
 *   2. computeSessionStartability folds in the two facts the gate can't see:
 *      terminal status (hidden) and an existing reusable workspace (startable
 *      from any status).
 */
import { describe, it, expect } from "bun:test";
import { sessionStartBlockedReason, computeSessionStartability } from "./session-startability";

describe("sessionStartBlockedReason (mt#2959)", () => {
  it("implementation-kind TODO names READY as the required precursor (not PLANNING)", () => {
    const reason = sessionStartBlockedReason("TODO", "implementation");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/READY/);
    // The originating defect: the old message said "Set status to PLANNING first"
    // for an implementation task, which then bounces off the READY gate.
    expect(reason).not.toMatch(/Set status to PLANNING first/);
  });

  it("umbrella-kind TODO names PLANNING as the required precursor", () => {
    const reason = sessionStartBlockedReason("TODO", "umbrella");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/PLANNING/);
  });

  it("implementation-kind PLANNING requires READY (regression: mt#1870 message)", () => {
    const reason = sessionStartBlockedReason("PLANNING", "implementation");
    expect(reason).toMatch(/READY when investigation is done/);
  });

  it("umbrella-kind PLANNING is startable (no READY state)", () => {
    expect(sessionStartBlockedReason("PLANNING", "umbrella")).toBeNull();
  });

  it("READY / IN-PROGRESS are startable for a fresh create", () => {
    expect(sessionStartBlockedReason("READY", "implementation")).toBeNull();
    expect(sessionStartBlockedReason("IN-PROGRESS", "implementation")).toBeNull();
  });

  it("is case-insensitive on status", () => {
    expect(sessionStartBlockedReason("todo", "implementation")).toMatch(/READY/);
  });

  it("defaults to implementation behavior when kind is empty", () => {
    expect(sessionStartBlockedReason("TODO", "")).toMatch(/READY/);
  });
});

describe("computeSessionStartability (mt#2959)", () => {
  it("terminal statuses are not startable and carry no reason (button hidden)", () => {
    expect(computeSessionStartability("DONE", "implementation", false)).toEqual({
      startable: false,
      startBlockedReason: null,
    });
    // Terminal beats an existing workspace — matches prior DONE/CLOSED hiding.
    expect(computeSessionStartability("CLOSED", "implementation", true)).toEqual({
      startable: false,
      startBlockedReason: null,
    });
  });

  it("an existing workspace is startable from any non-terminal status (reuse)", () => {
    expect(computeSessionStartability("TODO", "implementation", true)).toEqual({
      startable: true,
      startBlockedReason: null,
    });
  });

  it("implementation TODO with no workspace is blocked, reason names READY", () => {
    const result = computeSessionStartability("TODO", "implementation", false);
    expect(result.startable).toBe(false);
    expect(result.startBlockedReason).toMatch(/READY/);
  });

  it("implementation PLANNING with no workspace is blocked, reason names READY", () => {
    const result = computeSessionStartability("PLANNING", "implementation", false);
    expect(result.startable).toBe(false);
    expect(result.startBlockedReason).toMatch(/READY when investigation is done/);
  });

  it("READY (implementation) and PLANNING (umbrella) are startable with no workspace", () => {
    expect(computeSessionStartability("READY", "implementation", false)).toEqual({
      startable: true,
      startBlockedReason: null,
    });
    expect(computeSessionStartability("PLANNING", "umbrella", false)).toEqual({
      startable: true,
      startBlockedReason: null,
    });
  });
});
