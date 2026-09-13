import { describe, test, expect } from "bun:test";
import { emptyMembersRefusal, explainSuccessionRefusal } from "./work-package-succession";

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
