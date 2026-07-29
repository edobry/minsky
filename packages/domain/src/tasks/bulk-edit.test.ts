import { describe, test, expect } from "bun:test";
import {
  computeChangeSet,
  computeBlockedKindChanges,
  computeDryRunToken,
  checkRecordDrift,
  type BulkEditTaskState,
} from "./bulk-edit";

const task = (id: string, kind?: string | null, tags?: string[] | null): BulkEditTaskState => ({
  id,
  kind,
  tags,
});

describe("computeChangeSet", () => {
  test("emits kind records only for tasks whose kind actually changes", () => {
    const set = computeChangeSet([task("mt#1", "implementation"), task("mt#2", "umbrella")], {
      kind: "umbrella",
    });
    expect(set).toEqual([
      { taskId: "mt#1", field: "kind", before: "implementation", after: "umbrella" },
    ]);
  });

  test("treats a missing kind as the implementation default", () => {
    const set = computeChangeSet([task("mt#1", null)], { kind: "implementation" });
    expect(set).toEqual([]);
  });

  test("addTag is a no-op when the tag is already present", () => {
    const set = computeChangeSet([task("mt#1", undefined, ["a"])], { addTag: "a" });
    expect(set).toEqual([]);
  });

  test("removeTag is a no-op when the tag is absent", () => {
    const set = computeChangeSet([task("mt#1", undefined, ["a"])], { removeTag: "b" });
    expect(set).toEqual([]);
  });

  test("addTag + removeTag combine into a single tags record", () => {
    const set = computeChangeSet([task("mt#1", undefined, ["old"])], {
      addTag: "new",
      removeTag: "old",
    });
    expect(set).toEqual([{ taskId: "mt#1", field: "tags", before: ["old"], after: ["new"] }]);
  });

  test("records are sorted by taskId regardless of input order", () => {
    const set = computeChangeSet([task("mt#9", undefined, []), task("mt#1", undefined, [])], {
      addTag: "x",
    });
    expect(set.map((r) => r.taskId)).toEqual(["mt#1", "mt#9"]);
  });

  test("no ops produce an empty change set", () => {
    expect(computeChangeSet([task("mt#1", "implementation", ["a"])], {})).toEqual([]);
  });

  test("tag membership equality is order-insensitive (a pure reorder is not a change)", () => {
    const set = computeChangeSet([task("mt#1", undefined, ["b", "a"])], {
      addTag: "a",
    });
    expect(set).toEqual([]);
  });
});

describe("computeDryRunToken", () => {
  test("is deterministic for the same change set computed from any input order", () => {
    const a = computeChangeSet([task("mt#1", undefined, []), task("mt#2", undefined, [])], {
      addTag: "x",
    });
    const b = computeChangeSet([task("mt#2", undefined, []), task("mt#1", undefined, [])], {
      addTag: "x",
    });
    expect(computeDryRunToken(a)).toBe(computeDryRunToken(b));
    expect(computeDryRunToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("differs when the change set differs", () => {
    const a = computeChangeSet([task("mt#1", undefined, [])], { addTag: "x" });
    const b = computeChangeSet([task("mt#1", undefined, [])], { addTag: "y" });
    expect(computeDryRunToken(a)).not.toBe(computeDryRunToken(b));
  });
});

describe("checkRecordDrift", () => {
  const kindRecord = {
    taskId: "mt#1",
    field: "kind" as const,
    before: "implementation",
    after: "umbrella",
  };

  test("pending when current matches before", () => {
    expect(checkRecordDrift(kindRecord, task("mt#1", "implementation"))).toBe("pending");
  });

  test("applied when current matches after", () => {
    expect(checkRecordDrift(kindRecord, task("mt#1", "umbrella"))).toBe("applied");
  });

  test("drift when current matches neither", () => {
    expect(checkRecordDrift(kindRecord, task("mt#1", "state-ops"))).toBe("drift");
  });

  test("tags drift on membership change since dry-run", () => {
    const record = { taskId: "mt#1", field: "tags" as const, before: ["a"], after: ["a", "b"] };
    expect(checkRecordDrift(record, task("mt#1", undefined, ["a"]))).toBe("pending");
    expect(checkRecordDrift(record, task("mt#1", undefined, ["a", "b"]))).toBe("applied");
    expect(checkRecordDrift(record, task("mt#1", undefined, ["c"]))).toBe("drift");
  });

  test("tag reordering without membership change is NOT drift (set semantics)", () => {
    const record = {
      taskId: "mt#1",
      field: "tags" as const,
      before: ["a", "b"],
      after: ["a", "b", "c"],
    };
    expect(checkRecordDrift(record, task("mt#1", undefined, ["b", "a"]))).toBe("pending");
    expect(checkRecordDrift(record, task("mt#1", undefined, ["c", "b", "a"]))).toBe("applied");
  });
});

describe("bulk kind change — status stranding protection (mt#3137)", () => {
  /** implementation/READY → umbrella is the reproduced stranding case. */
  const stranding: BulkEditTaskState = {
    id: "mt#stranded",
    kind: "implementation",
    status: "READY",
  };
  /** implementation/TODO → umbrella is safe: umbrella recognizes TODO. */
  const safe: BulkEditTaskState = { id: "mt#safe", kind: "implementation", status: "TODO" };

  test("a status-incompatible record is EXCLUDED from the change set", () => {
    const changeSet = computeChangeSet([stranding], { kind: "umbrella" });
    expect(changeSet).toEqual([]);
  });

  test("...and is reported as blocked, with the conflict attached", () => {
    const blocked = computeBlockedKindChanges([stranding], { kind: "umbrella" });

    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.taskId).toBe("mt#stranded");
    expect(blocked[0]?.conflict.status).toBe("READY");
    expect(blocked[0]?.conflict.legalStatuses).not.toContain("READY");
  });

  test("a compatible sibling in the SAME batch still converts", () => {
    // The heterogeneous case the spec calls out: one blocked record must not
    // suppress the rest, and one convertible record must not carry the blocked
    // one along with it.
    const changeSet = computeChangeSet([stranding, safe], { kind: "umbrella" });

    expect(changeSet).toHaveLength(1);
    expect(changeSet[0]?.taskId).toBe("mt#safe");

    const blocked = computeBlockedKindChanges([stranding, safe], { kind: "umbrella" });
    expect(blocked.map((b) => b.taskId)).toEqual(["mt#stranded"]);
  });

  test("the blocked record is absent from the token — it cannot be applied by it", () => {
    const withBlocked = computeDryRunToken(
      computeChangeSet([stranding, safe], { kind: "umbrella" })
    );
    const safeOnly = computeDryRunToken(computeChangeSet([safe], { kind: "umbrella" }));

    // Identical tokens prove the blocked record contributed nothing to the
    // approved change set.
    expect(withBlocked).toBe(safeOnly);
  });

  test("tag ops on a status-incompatible task are unaffected — only kind is gated", () => {
    const changeSet = computeChangeSet([{ ...stranding, tags: [] }], { addTag: "x" });
    expect(changeSet).toHaveLength(1);
    expect(changeSet[0]?.field).toBe("tags");
  });

  test("no kind op means nothing is ever blocked", () => {
    expect(computeBlockedKindChanges([stranding], { addTag: "x" })).toEqual([]);
  });

  test("a task with no status is not blocked — there is nothing to strand", () => {
    const noStatus: BulkEditTaskState = { id: "mt#nostatus", kind: "implementation" };
    expect(computeBlockedKindChanges([noStatus], { kind: "umbrella" })).toEqual([]);
    expect(computeChangeSet([noStatus], { kind: "umbrella" })).toHaveLength(1);
  });

  test("a no-op kind change is never blocked, even from an odd status", () => {
    const already: BulkEditTaskState = { id: "mt#x", kind: "umbrella", status: "TODO" };
    expect(computeBlockedKindChanges([already], { kind: "umbrella" })).toEqual([]);
  });
});
