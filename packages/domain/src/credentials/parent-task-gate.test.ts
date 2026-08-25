/**
 * Tests for the parent-task gate (mt#4486).
 *
 * Both IO calls are injected, so these exercise the whole shell — decision,
 * write, and failure handling — with no database and no patched collaborator.
 */

import { describe, expect, test } from "bun:test";
import { blockParentTask, releaseParentTask, type ParentTaskGateDeps } from "./parent-task-gate";

const REQ = { id: "uuid-req-1", shortId: "ask#77" };

/** A recording fake. `readTask` returns whatever the test seeds. */
function fakeDeps(
  task: { status: string; kind?: string | null } | null,
  overrides: Partial<ParentTaskGateDeps> = {}
): ParentTaskGateDeps & { writes: Array<{ taskId: string; status: string }> } {
  const writes: Array<{ taskId: string; status: string }> = [];
  return {
    writes,
    readTask: async () => task,
    setStatus: async (taskId, status) => {
      writes.push({ taskId, status });
    },
    ...overrides,
  };
}

describe("blockParentTask", () => {
  test("blocks a READY parent and reports the entry status", async () => {
    const deps = fakeDeps({ status: "READY" });
    const r = await blockParentTask(deps, "mt#1", REQ);

    expect(r.outcome).toBe("blocked");
    if (r.outcome === "blocked") {
      expect(r.entryStatus).toBe("READY");
      expect(r.reason).toContain("ask#77");
    }
    expect(deps.writes).toEqual([{ taskId: "mt#1", status: "BLOCKED" }]);
  });

  test("skips a TODO parent WITHOUT writing anything", async () => {
    // The likely case. The request must still succeed — SC4.
    const deps = fakeDeps({ status: "TODO" });
    const r = await blockParentTask(deps, "mt#1", REQ);

    expect(r.outcome).toBe("skipped");
    if (r.outcome === "skipped") expect(r.why).toBe("status-not-blockable");
    expect(deps.writes).toEqual([]);
  });

  test("skips a state-ops parent with its own distinct reason", async () => {
    const deps = fakeDeps({ status: "PLANNING", kind: "state-ops" });
    const r = await blockParentTask(deps, "mt#1", REQ);

    expect(r.outcome).toBe("skipped");
    if (r.outcome === "skipped") expect(r.why).toBe("kind-forbids-blocked");
    expect(deps.writes).toEqual([]);
  });

  test("skips a task that does not exist", async () => {
    const r = await blockParentTask(fakeDeps(null), "mt#nope", REQ);
    expect(r.outcome).toBe("skipped");
    if (r.outcome === "skipped") expect(r.why).toBe("task-not-found");
  });

  test("a write failure is REPORTED, not thrown — the request must still succeed", async () => {
    const deps = fakeDeps(
      { status: "READY" },
      {
        setStatus: async () => {
          throw new Error("transition refused");
        },
      }
    );
    const r = await blockParentTask(deps, "mt#1", REQ);

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") expect(r.error).toContain("transition refused");
  });

  test("a read failure is reported the same way", async () => {
    const deps = fakeDeps(null, {
      readTask: async () => {
        throw new Error("db down");
      },
    });
    expect((await blockParentTask(deps, "mt#1", REQ)).outcome).toBe("failed");
  });
});

describe("releaseParentTask", () => {
  test("returns a task blocked from READY to READY", async () => {
    const deps = fakeDeps({ status: "BLOCKED" });
    const r = await releaseParentTask(deps, "mt#1", "READY", REQ);

    expect(r.outcome).toBe("released");
    if (r.outcome === "released") {
      expect(r.target).toBe("READY");
      expect(r.reason).not.toContain("no edge back");
    }
    expect(deps.writes).toEqual([{ taskId: "mt#1", status: "READY" }]);
  });

  test("returns a task blocked from PLANNING to PLANNING", async () => {
    const deps = fakeDeps({ status: "BLOCKED" });
    await releaseParentTask(deps, "mt#1", "PLANNING", REQ);
    expect(deps.writes).toEqual([{ taskId: "mt#1", status: "PLANNING" }]);
  });

  test.each(["IN-PROGRESS", "IN-REVIEW"])(
    "a task blocked from %s lands on READY and SAYS position was lost",
    async (entry) => {
      const deps = fakeDeps({ status: "BLOCKED" });
      const r = await releaseParentTask(deps, "mt#1", entry, REQ);

      expect(deps.writes).toEqual([{ taskId: "mt#1", status: "READY" }]);
      if (r.outcome === "released") expect(r.reason).toContain("no edge back");
    }
  );

  test("no entry status means the parent was never blocked — nothing to do", async () => {
    const deps = fakeDeps({ status: "READY" });
    const r = await releaseParentTask(deps, "mt#1", undefined, REQ);

    expect(r.outcome).toBe("skipped");
    if (r.outcome === "skipped") expect(r.why).toBe("no-entry-status");
    expect(deps.writes).toEqual([]);
  });

  test("does NOT clobber a task the principal already moved", async () => {
    // The task is IN-PROGRESS, not BLOCKED — someone unblocked it by hand
    // between the block and the sweep. Writing over that would replace a human
    // decision with a stale view.
    const deps = fakeDeps({ status: "IN-PROGRESS" });
    const r = await releaseParentTask(deps, "mt#1", "READY", REQ);

    expect(r.outcome).toBe("skipped");
    if (r.outcome === "skipped") expect(r.why).toBe("not-blocked");
    expect(deps.writes).toEqual([]);
  });

  test("a write failure is reported, so the sweep's remaining batch survives", async () => {
    const deps = fakeDeps(
      { status: "BLOCKED" },
      {
        setStatus: async () => {
          throw new Error("nope");
        },
      }
    );
    expect((await releaseParentTask(deps, "mt#1", "READY", REQ)).outcome).toBe("failed");
  });
});
