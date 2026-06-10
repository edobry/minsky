// Tests for the tasks_create duplicate-child guard (mt#1435).
//
// All pure / hermetic: the CLI-backed `fetchTaskChildren` is never invoked —
// `decideTasksCreateGuard` takes an injected `fetchChildren` dependency.

import { describe, expect, it } from "bun:test";

import {
  tokenizeTitle,
  titleOverlapTokens,
  detectDuplicateChild,
  parseChildIdsFromChildrenOutput,
  formatDuplicateBlockMessage,
  decideTasksCreateGuard,
  DUPLICATE_TOKEN_THRESHOLD,
  type ChildTask,
} from "./parallel-work-guard";

function child(id: string, title: string, status = "TODO"): ChildTask {
  return { id, title, status };
}

// Shared fixtures (extracted to satisfy custom/no-magic-string-duplication).
const RAIL_TITLE = "Cockpit shell A: persistent rail";

describe("tokenizeTitle (mt#1435)", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenizeTitle("Persistent Rail")).toEqual(new Set(["persistent", "rail"]));
  });

  it("drops tokens shorter than 4 chars", () => {
    expect(tokenizeTitle("a be rail tab")).toEqual(new Set(["rail"]));
  });

  it("drops 4+-char stopwords but keeps domain nouns", () => {
    const t = tokenizeTitle("Cockpit shell with into when task");
    expect(t.has("cockpit")).toBe(true);
    expect(t.has("shell")).toBe(true);
    expect(t.has("with")).toBe(false);
    expect(t.has("into")).toBe(false);
    expect(t.has("when")).toBe(false);
    expect(t.has("task")).toBe(false);
  });

  it("treats hyphens, slashes, colons, parens as separators", () => {
    expect(tokenizeTitle("shell-A: rail/tab (cmdk)")).toEqual(new Set(["shell", "rail", "cmdk"]));
  });

  it("keeps alphanumeric tokens like navsheet", () => {
    expect(tokenizeTitle("retire NavSheet hamburger")).toEqual(
      new Set(["retire", "navsheet", "hamburger"])
    );
  });

  it("returns empty set for empty / all-stopword / all-short titles", () => {
    expect(tokenizeTitle("")).toEqual(new Set());
    expect(tokenizeTitle("the and for a b c")).toEqual(new Set());
  });
});

describe("titleOverlapTokens (mt#1435)", () => {
  it("returns shared substantive tokens", () => {
    const shared = titleOverlapTokens(
      "Persistent rail replacing NavSheet",
      "Persistent rail retire NavSheet hamburger"
    );
    expect(new Set(shared)).toEqual(new Set(["persistent", "rail", "navsheet"]));
  });

  it("is case-insensitive", () => {
    expect(titleOverlapTokens("RAIL widget", "rail thing")).toEqual(["rail"]);
  });

  it("returns empty when no substantive token is shared", () => {
    expect(titleOverlapTokens("alpha bravo", "charlie delta")).toEqual([]);
  });

  it("does not count stopwords as overlap", () => {
    expect(titleOverlapTokens("when with into", "when with into")).toEqual([]);
  });
});

describe("detectDuplicateChild (mt#1435)", () => {
  it("flags a child sharing >= threshold tokens", () => {
    const m = detectDuplicateChild("severity-inflation guard", [
      child("mt#1189", "Reviewer severity inflation guard heuristic"),
    ]);
    expect(m).not.toBeNull();
    expect(m?.child.id).toBe("mt#1189");
    expect(new Set(m?.tokens)).toEqual(new Set(["severity", "inflation", "guard"]));
  });

  it("returns null when overlap is below threshold", () => {
    const m = detectDuplicateChild("totally unrelated thing", [
      child("mt#1189", "Reviewer severity inflation guard heuristic"),
    ]);
    expect(m).toBeNull();
  });

  it("returns null with exactly one shared token (below threshold of 2)", () => {
    const m = detectDuplicateChild("persistent banana", [child("mt#1", "persistent rail")]);
    expect(m).toBeNull();
    expect(DUPLICATE_TOKEN_THRESHOLD).toBe(2);
  });

  it("returns the strongest match when several children overlap", () => {
    const m = detectDuplicateChild("cockpit shell persistent rail navsheet", [
      child("mt#1", "cockpit shell something"), // 2 tokens
      child("mt#2", "cockpit shell persistent rail navsheet hamburger"), // 5 tokens
      child("mt#3", "cockpit widget"), // 1 token
    ]);
    expect(m?.child.id).toBe("mt#2");
  });

  it("returns null for an empty children list", () => {
    expect(detectDuplicateChild("anything at all here", [])).toBeNull();
  });

  it("R6 regression: the real mt#2403-vs-mt#2397 titles collide", () => {
    const m = detectDuplicateChild(
      "Cockpit shell A: persistent workstream-primary rail (replace NavSheet hamburger overlay)",
      [
        child(
          "mt#2397",
          "Cockpit shell A: persistent rail (retire NavSheet hamburger) — attention-pinned + workstream nav + browse entities",
          "DONE"
        ),
      ]
    );
    expect(m).not.toBeNull();
    expect(m?.child.id).toBe("mt#2397");
    expect((m?.tokens.length ?? 0) >= DUPLICATE_TOKEN_THRESHOLD).toBe(true);
  });

  it("R6 regression: catches an IN-PROGRESS sibling, not just DONE/CLOSED", () => {
    const m = detectDuplicateChild(
      "Cockpit shell B: tabbed workspace region + entity-agnostic tab model",
      [
        child(
          "mt#2398",
          "Cockpit shell B: tabbed workspace + entity-agnostic tab model + master-detail URL unification",
          "IN-PROGRESS"
        ),
      ]
    );
    expect(m?.child.id).toBe("mt#2398");
    expect(m?.child.status).toBe("IN-PROGRESS");
  });
});

describe("parseChildIdsFromChildrenOutput (mt#1435)", () => {
  it("parses indented child IDs and ignores the header line", () => {
    const out = "mt#2370: 3 subtask(s)\n  mt#2397\n  mt#2398\n  mt#2399\n";
    expect(parseChildIdsFromChildrenOutput(out)).toEqual(["mt#2397", "mt#2398", "mt#2399"]);
  });

  it("returns empty for the 'no subtasks' case", () => {
    expect(parseChildIdsFromChildrenOutput("mt#2370: no subtasks")).toEqual([]);
  });

  it("handles md# ids", () => {
    expect(parseChildIdsFromChildrenOutput("md#10: 1 subtask(s)\n  md#11\n")).toEqual(["md#11"]);
  });

  it("ignores non-indented or malformed lines", () => {
    const out = "mt#1: 2 subtask(s)\nmt#999 not indented\n  mt#2\n  garbage line\n";
    expect(parseChildIdsFromChildrenOutput(out)).toEqual(["mt#2"]);
  });

  it("returns empty for empty input", () => {
    expect(parseChildIdsFromChildrenOutput("")).toEqual([]);
  });
});

describe("formatDuplicateBlockMessage (mt#1435)", () => {
  const msg = formatDuplicateBlockMessage("mt#2370", "Cockpit shell A: rail", {
    child: child("mt#2397", RAIL_TITLE, "DONE"),
    tokens: ["cockpit", "shell", "rail"],
  });

  it("names the colliding child id and status", () => {
    expect(msg).toContain("mt#2397");
    expect(msg).toContain("[DONE]");
  });

  it("lists the overlapping tokens", () => {
    expect(msg).toContain("cockpit, shell, rail");
  });

  it("names the parent and the children command", () => {
    expect(msg).toContain("mt#2370");
    expect(msg).toContain("minsky tasks children mt#2370");
  });

  it("includes the override hint", () => {
    expect(msg).toContain("MINSKY_FORCE_DUPLICATE_OK=1");
  });
});

describe("decideTasksCreateGuard (mt#1435)", () => {
  const children = [child("mt#2397", RAIL_TITLE, "DONE")];
  const fetchOk = () => children;
  const fetchNull = () => null;

  it("skips when there is no parent (top-level create)", () => {
    const d = decideTasksCreateGuard(
      { title: RAIL_TITLE },
      { fetchChildren: fetchOk, overrideActive: false }
    );
    expect(d.action).toBe("skip");
  });

  it("skips when there is a parent but no title", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370" },
      { fetchChildren: fetchOk, overrideActive: false }
    );
    expect(d.action).toBe("skip");
  });

  it("blocks on a duplicate child", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: "Cockpit shell A: persistent rail (variant)" },
      { fetchChildren: fetchOk, overrideActive: false }
    );
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.message).toContain("mt#2397");
  });

  it("permits when no child overlaps", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: "Embeddings reindex throughput probe" },
      { fetchChildren: fetchOk, overrideActive: false }
    );
    expect(d.action).toBe("permit");
  });

  it("skips (warn-and-permit) when children cannot be enumerated", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: RAIL_TITLE },
      { fetchChildren: fetchNull, overrideActive: false }
    );
    expect(d.action).toBe("skip");
  });

  it("override bypasses the block and reports the would-be match for audit", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: "Cockpit shell A: persistent rail (variant)" },
      { fetchChildren: fetchOk, overrideActive: true }
    );
    expect(d.action).toBe("override");
    if (d.action === "override") expect(d.auditMatch).toBe("mt#2397");
  });

  it("override reports 'none' when there is no would-be duplicate", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: "Embeddings reindex throughput probe" },
      { fetchChildren: fetchOk, overrideActive: true }
    );
    expect(d.action).toBe("override");
    if (d.action === "override") expect(d.auditMatch).toBe("none");
  });

  it("override tolerates a null children fetch (treats as empty)", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: "anything" },
      { fetchChildren: fetchNull, overrideActive: true }
    );
    expect(d.action).toBe("override");
    if (d.action === "override") expect(d.auditMatch).toBe("none");
  });

  it("ignores non-string parent/title shapes", () => {
    const d = decideTasksCreateGuard(
      { parent: 123, title: ["x"] },
      { fetchChildren: fetchOk, overrideActive: false }
    );
    expect(d.action).toBe("skip");
  });
});
