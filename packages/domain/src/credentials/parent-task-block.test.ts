/**
 * Tests for the parent-task blocking decisions (mt#4486).
 *
 * The entry/exit cases are asserted against the REAL workflow registry rather
 * than a fixture, because the whole point of deriving from it is that these
 * decisions cannot drift from the machine that validates the write. A fixture
 * would let the two diverge silently, which is the failure this module exists to
 * avoid.
 */

import { describe, expect, test } from "bun:test";
import {
  blockReason,
  decideParentBlock,
  decideParentRelease,
  releaseReason,
} from "./parent-task-block";

describe("decideParentBlock — entry", () => {
  test.each(["PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW"])(
    "%s can be blocked, and the entry status is carried",
    (status) => {
      const d = decideParentBlock({ status });
      expect(d.block).toBe(true);
      if (d.block) expect(d.entryStatus).toBe(status);
    }
  );

  test("TODO cannot be blocked — the likely case, not an exotic one", () => {
    // `TODO: ["PLANNING", "CLOSED"]` in the implementation workflow. A request
    // filed against unplanned work must not fail; it skips the block instead.
    const d = decideParentBlock({ status: "TODO" });
    expect(d.block).toBe(false);
    if (!d.block) expect(d.reason).toBe("status-not-blockable");
  });

  test.each(["DONE", "CLOSED", "BLOCKED"])("%s is not blockable either", (status) => {
    expect(decideParentBlock({ status }).block).toBe(false);
  });

  test("a state-ops parent is refused for a DIFFERENT reason than a TODO one", () => {
    // mt#3214: that kind has no BLOCKED state at all. The two skip reasons mean
    // different things to a reader — a TODO parent is ordinary, a state-ops
    // parent means the caller bound a credential request to the wrong kind.
    const d = decideParentBlock({ status: "PLANNING", kind: "state-ops" });
    expect(d.block).toBe(false);
    if (!d.block) {
      expect(d.reason).toBe("kind-forbids-blocked");
      expect(d.kind).toBe("state-ops");
    }
  });

  test("an unknown kind falls back to implementation rather than throwing", () => {
    expect(decideParentBlock({ status: "READY", kind: "no-such-kind" }).block).toBe(true);
  });

  test.each([null, undefined, ""])("kind %p defaults to implementation", (kind) => {
    expect(decideParentBlock({ status: "READY", kind }).block).toBe(true);
  });

  test("the decision agrees with the workflow registry, not a copied list", async () => {
    // The control that makes the other entry tests meaningful: if this module
    // hardcoded a status list, it could pass every case above while disagreeing
    // with the machine that validates the write.
    const { getWorkflow } = await import("../tasks/workflows");
    const wf = getWorkflow("implementation");
    for (const status of wf.states) {
      const expected = (wf.transitions[status] ?? []).includes("BLOCKED");
      expect(decideParentBlock({ status }).block, `status ${status}`).toBe(expected);
    }
  });
});

describe("decideParentRelease — exit", () => {
  test.each(["PLANNING", "READY"])("%s round-trips exactly", (status) => {
    expect(decideParentRelease(status)).toEqual({ target: status, positionLost: false });
  });

  test.each(["IN-PROGRESS", "IN-REVIEW"])("%s cannot be restored and lands on READY", (status) => {
    // `BLOCKED: ["TODO", "PLANNING", "READY", "CLOSED"]` — no edge back to
    // either. READY over PLANNING because the task already passed its planning
    // gate before it was blocked.
    expect(decideParentRelease(status)).toEqual({ target: "READY", positionLost: true });
  });

  test("every release target is a legal BLOCKED exit", async () => {
    const { getWorkflow } = await import("../tasks/workflows");
    const exits = getWorkflow("implementation").transitions["BLOCKED"] ?? [];
    for (const entry of ["PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW"]) {
      expect(exits, `release from ${entry}`).toContain(decideParentRelease(entry).target);
    }
  });
});

describe("transition reasons name the ask", () => {
  test("block reason prefers the short id", () => {
    expect(blockReason("ask#42", "uuid-1")).toContain("ask#42");
  });

  test("block reason falls back to the uuid", () => {
    expect(blockReason(undefined, "uuid-1")).toContain("uuid-1");
  });

  test("release reason says so when position was lost", () => {
    const r = releaseReason("ask#42", "uuid-1", { target: "READY", positionLost: true });
    expect(r).toContain("no edge back");
  });

  test("release reason stays quiet when it was not", () => {
    const r = releaseReason("ask#42", "uuid-1", { target: "READY", positionLost: false });
    expect(r).not.toContain("no edge back");
  });
});
