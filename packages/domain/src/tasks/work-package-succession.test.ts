import { describe, test, expect } from "bun:test";
import {
  dedupeMembers,
  emptyMembersRefusal,
  explainSuccessionRefusal,
  isSucceedableRow,
} from "./work-package-succession";

// The pure half of succession: the refusal diagnoses the transaction returns
// from the locked row. The store itself is exercised against a real Postgres in
// tests/integration/work-package-succession.testcontainer.integration.test.ts.

describe("explainSuccessionRefusal (mt#5133)", () => {
  test("no row → not-found", () => {
    const out = explainSuccessionRefusal("mt#404", undefined);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("not-found");
    expect(out.message).toContain("mt#404");
  });

  test("an ordinary task → wrong-kind naming the kind", () => {
    const out = explainSuccessionRefusal("mt#1", {
      kind: "implementation",
      status: "IN-PROGRESS",
      claimedBy: null,
    });
    expect(out.ok).toBe(false);
    if (out.ok || out.reason !== "wrong-kind") throw new Error("expected wrong-kind");
    expect(out.kind).toBe("implementation");
  });

  test("a READY (unclaimed) package → not-claimed carrying the status", () => {
    const out = explainSuccessionRefusal("mt#2", {
      kind: "work-package",
      status: "READY",
      claimedBy: null,
    });
    expect(out.ok).toBe(false);
    if (out.ok || out.reason !== "not-claimed") throw new Error("expected not-claimed");
    expect(out.status).toBe("READY");
    expect(out.message).toContain("claim it first");
  });

  test("a DONE package → not-claimed too: succession is the holder's act", () => {
    const out = explainSuccessionRefusal("mt#3", {
      kind: "work-package",
      status: "DONE",
      claimedBy: null,
    });
    if (out.ok || out.reason !== "not-claimed") throw new Error("expected not-claimed");
    expect(out.status).toBe("DONE");
  });

  test("IN-PROGRESS with no recorded holder → not-claimed, naming the missing holder (PR #3751 R1)", () => {
    const out = explainSuccessionRefusal("mt#4", {
      kind: "work-package",
      status: "IN-PROGRESS",
      claimedBy: null,
    });
    if (out.ok || out.reason !== "not-claimed") throw new Error("expected not-claimed");
    expect(out.status).toBe("IN-PROGRESS");
    expect(out.message).toContain("records no holder");
  });
});

describe("isSucceedableRow", () => {
  test("only a held (IN-PROGRESS + claimed_by) work package qualifies", () => {
    const held = { kind: "work-package", status: "IN-PROGRESS", claimedBy: "conv:x" };
    expect(isSucceedableRow(held)).toBe(true);
    expect(isSucceedableRow({ ...held, claimedBy: null })).toBe(false);
    expect(isSucceedableRow({ ...held, claimedBy: "" })).toBe(false);
    expect(isSucceedableRow({ ...held, status: "READY" })).toBe(false);
    expect(isSucceedableRow({ ...held, kind: "implementation" })).toBe(false);
    expect(isSucceedableRow(undefined)).toBe(false);
  });
});

describe("dedupeMembers", () => {
  test("first occurrence wins, order kept", () => {
    expect(
      dedupeMembers([
        { taskId: "mt#2", rationale: "a" },
        { taskId: "mt#1", rationale: "b" },
        { taskId: "mt#2", rationale: "c" },
      ])
    ).toEqual([
      { taskId: "mt#2", rationale: "a" },
      { taskId: "mt#1", rationale: "b" },
    ]);
  });
});

describe("emptyMembersRefusal", () => {
  test("names the close-instead path", () => {
    const out = emptyMembersRefusal("mt#5");
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("empty-members");
    expect(out.message).toContain("tasks packages sweep");
    expect(out.message).toContain("mt#5");
  });
});
