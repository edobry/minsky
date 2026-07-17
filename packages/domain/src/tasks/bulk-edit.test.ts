import { describe, test, expect } from "bun:test";
import {
  computeChangeSet,
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
