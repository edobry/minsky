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
  parseTaskListJson,
  formatDuplicateBlockMessage,
  decideTasksCreateGuard,
  resolveDuplicateGuardOverride,
  resolveDuplicateGuardParent,
  isNewTaskModeDispatch,
  DUPLICATE_CHILD_GUARD_NAME,
  DUPLICATE_TOKEN_THRESHOLD,
  type ChildTask,
} from "./parallel-work-guard";
import { checkOverride } from "./dispatcher";
import type { OverrideResult } from "./dispatcher";
import { findValidGuardGrant } from "./guard-grant-store";
import type { GuardGrant } from "./guard-grant-store";

function child(id: string, title: string, status = "TODO"): ChildTask {
  return { id, title, status };
}

// Shared fixtures (extracted to satisfy custom/no-magic-string-duplication).
const RAIL_TITLE = "Cockpit shell A: persistent rail";
/** A title that token-overlaps RAIL_TITLE's child ("mt#2397") but is a distinct task. */
const RAIL_VARIANT_TITLE = "Cockpit shell A: persistent rail (variant)";
/** A title sharing no substantive tokens with RAIL_TITLE (the clean-permit case). */
const NON_OVERLAPPING_TITLE = "Embeddings reindex throughput probe";

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

  it("drops the expanded common function-word stopwords (PR #1660 R1)", () => {
    const t = tokenizeTitle("which there these those about would build");
    for (const sw of ["which", "there", "these", "those", "about", "would"]) {
      expect(t.has(sw)).toBe(false);
    }
    expect(t.has("build")).toBe(true); // a real content word is still kept
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

describe("detectDuplicateChild parent-vocabulary discount (mt#2683)", () => {
  it("discounts shared tokens that appear in the parent title", () => {
    // shared: transcript, archive, storage; parent contributes transcript +
    // storage -> counted: [archive] -> below threshold -> no match.
    const m = detectDuplicateChild(
      "transcript archive storage layer",
      [child("mt#1", "transcript storage archive design")],
      { parentTitle: "Transcript storage epic" }
    );
    expect(m).toBeNull();
  });

  it("applies no discount when parentTitle is absent (back-compat)", () => {
    const m = detectDuplicateChild("transcript archive storage layer", [
      child("mt#1", "transcript storage archive design"),
    ]);
    expect(m).not.toBeNull();
  });

  it("reports discounted tokens on the match and keeps counted tokens separate", () => {
    const m = detectDuplicateChild(
      "transcript archive bucket thing",
      [child("mt#1", "transcript archive bucket design")],
      { parentTitle: "Transcript epic" }
    );
    expect(m).not.toBeNull();
    expect(new Set(m?.tokens)).toEqual(new Set(["archive", "bucket"]));
    expect(m?.discounted).toEqual(["transcript"]);
  });
});

describe("resolveDuplicateGuardParent + isNewTaskModeDispatch (mt#2683)", () => {
  it("reads parent (tasks_create) and falls back to parentTaskId (dispatch new-task mode)", () => {
    expect(resolveDuplicateGuardParent({ parent: "mt#1" })).toBe("mt#1");
    expect(resolveDuplicateGuardParent({ parentTaskId: "mt#2" })).toBe("mt#2");
    expect(resolveDuplicateGuardParent({})).toBe("");
    expect(resolveDuplicateGuardParent({ parent: 3, parentTaskId: ["x"] })).toBe("");
  });

  it("isNewTaskModeDispatch: title without taskId", () => {
    expect(isNewTaskModeDispatch({ title: "New child" })).toBe(true);
    expect(isNewTaskModeDispatch({ title: "x", parentTaskId: "mt#1" })).toBe(true);
    expect(isNewTaskModeDispatch({ taskId: "mt#9" })).toBe(false);
    expect(isNewTaskModeDispatch({ title: "x", taskId: "mt#9" })).toBe(false);
  });

  it("dispatch new-task-mode parity: parentTaskId routes the same dedup as parent", () => {
    const sibling = child("mt#2397", RAIL_TITLE, "TODO");
    const dCreate = decideTasksCreateGuard(
      { parent: "mt#2370", title: RAIL_VARIANT_TITLE },
      { fetchChildren: () => [sibling], overrideActive: false }
    );
    const dDispatch = decideTasksCreateGuard(
      { parentTaskId: "mt#2370", title: RAIL_VARIANT_TITLE },
      { fetchChildren: () => [sibling], overrideActive: false }
    );
    expect(dCreate.action).toBe("block");
    expect(dDispatch.action).toBe("block");
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

  it("tolerates bullet markers and trailing status text (CLI format drift, PR #1660 R1)", () => {
    const out =
      "mt#2370: 3 subtask(s)\n  - mt#2397 — DONE\n  * mt#2398 (IN-PROGRESS)\n  mt#2399  extra trailing stuff\n";
    expect(parseChildIdsFromChildrenOutput(out)).toEqual(["mt#2397", "mt#2398", "mt#2399"]);
  });

  it("still excludes the non-indented header even with trailing text", () => {
    expect(parseChildIdsFromChildrenOutput("mt#2370: 3 subtask(s)")).toEqual([]);
  });
});

describe("parseTaskListJson (mt#1435, PR #1660 R1)", () => {
  it("parses a bare array into an id -> {title,status} map", () => {
    const out = JSON.stringify([
      { id: "mt#1", title: "Alpha", status: "TODO" },
      { id: "mt#2", title: "Bravo", status: "IN-PROGRESS" },
    ]);
    const m = parseTaskListJson(out);
    expect(m.get("mt#1")).toEqual({ title: "Alpha", status: "TODO" });
    expect(m.get("mt#2")).toEqual({ title: "Bravo", status: "IN-PROGRESS" });
  });

  it("parses a { tasks: [...] } envelope", () => {
    const out = JSON.stringify({ tasks: [{ id: "mt#3", title: "Charlie", status: "READY" }] });
    expect(parseTaskListJson(out).get("mt#3")).toEqual({ title: "Charlie", status: "READY" });
  });

  it("defaults a missing status to UNKNOWN and skips entries without id/title", () => {
    const out = JSON.stringify([
      { id: "mt#4", title: "Delta" },
      { id: "mt#5" },
      { title: "no id" },
    ]);
    const m = parseTaskListJson(out);
    expect(m.get("mt#4")).toEqual({ title: "Delta", status: "UNKNOWN" });
    expect(m.has("mt#5")).toBe(false);
    expect(m.size).toBe(1);
  });

  it("returns an empty map for malformed JSON (callers fall back to per-child gets)", () => {
    expect(parseTaskListJson("not json").size).toBe(0);
    expect(parseTaskListJson("").size).toBe(0);
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

  it("includes the mid-session grant-issuance hint (mt#2658)", () => {
    expect(msg).toContain("scripts/grant-guard-override.ts");
    expect(msg).toContain(`--guard ${DUPLICATE_CHILD_GUARD_NAME}`);
    expect(msg).toContain("--scope mt#2370");
    expect(msg).toContain("--reason");
  });

  it("omits the discounted line when nothing was discounted", () => {
    expect(msg).not.toContain("Discounted");
  });

  it("shows discounted parent-vocabulary tokens when present (mt#2683)", () => {
    const withDiscount = formatDuplicateBlockMessage("mt#2581", "some title", {
      child: child("mt#2582", "sibling title", "DONE"),
      tokens: ["archive", "object"],
      discounted: ["storage"],
    });
    expect(withDiscount).toContain("Discounted (parent-title vocabulary, not counted): storage");
  });
});

describe("resolveDuplicateGuardOverride (mt#2658)", () => {
  const PARENT = "mt#2581";

  it("returns inactive when neither the env var nor a grant matches", () => {
    const checkOverrideFn = (): OverrideResult => ({ overridden: false });
    const result = resolveDuplicateGuardOverride(PARENT, {}, checkOverrideFn);
    expect(result).toEqual({ active: false });
  });

  it("legacy MINSKY_FORCE_DUPLICATE_OK=1 activates via source 'env', without consulting checkOverrideFn", () => {
    let called = false;
    const checkOverrideFn = (): OverrideResult => {
      called = true;
      return { overridden: false };
    };
    const result = resolveDuplicateGuardOverride(
      PARENT,
      { MINSKY_FORCE_DUPLICATE_OK: "1" },
      checkOverrideFn
    );
    expect(result).toEqual({ active: true, source: "env" });
    expect(called).toBe(false);
  });

  it("a grant match (via checkOverrideFn) activates via source 'grant' with its reason", () => {
    const checkOverrideFn = (): OverrideResult => ({
      overridden: true,
      grantReason: "concurrent decomposition — distinct sibling",
    });
    const result = resolveDuplicateGuardOverride(PARENT, {}, checkOverrideFn);
    expect(result).toEqual({
      active: true,
      source: "grant",
      reason: "concurrent decomposition — distinct sibling",
    });
  });

  it("passes the guard name and parent as scope through to checkOverrideFn", () => {
    let seenGuardName: string | null = null;
    let seenScope: string | undefined;
    const checkOverrideFn = (
      guardName: string,
      _env: NodeJS.ProcessEnv,
      options?: { scope?: string }
    ): OverrideResult => {
      seenGuardName = guardName;
      seenScope = options?.scope;
      return { overridden: false };
    };
    resolveDuplicateGuardOverride(PARENT, {}, checkOverrideFn);
    expect(seenGuardName).toBe(DUPLICATE_CHILD_GUARD_NAME);
    expect(seenScope).toBe(PARENT);
  });

  it("passes scope=undefined through to checkOverrideFn when there is no parent", () => {
    let seenScope: string | undefined = "unset";
    const checkOverrideFn = (
      _guardName: string,
      _env: NodeJS.ProcessEnv,
      options?: { scope?: string }
    ): OverrideResult => {
      seenScope = options?.scope;
      return { overridden: false };
    };
    resolveDuplicateGuardOverride(undefined, {}, checkOverrideFn);
    expect(seenScope).toBeUndefined();
  });

  it("MINSKY_FORCE_DUPLICATE_OK set to something other than '1' does not activate the env path", () => {
    const checkOverrideFn = (): OverrideResult => ({ overridden: false });
    const result = resolveDuplicateGuardOverride(
      PARENT,
      { MINSKY_FORCE_DUPLICATE_OK: "true" },
      checkOverrideFn
    );
    expect(result).toEqual({ active: false });
  });

  it("a checkOverrideFn hit with overridden:true and no grantReason (the unified MINSKY_HOOK_OVERRIDE path) activates via source 'env', not 'grant'", () => {
    // Reviewer finding (PR #1838 R1 BLOCKING 1): checkOverride() also fires
    // for MINSKY_HOOK_OVERRIDE=duplicate-child-matcher, returning
    // `{ overridden: true }` with `grantReason` undefined — that must be
    // labeled "env", not "grant" (which would report a nonsensical
    // `reason=undefined` in the audit line).
    const checkOverrideFn = (): OverrideResult => ({
      overridden: true,
      raw: "duplicate-child-matcher",
    });
    const result = resolveDuplicateGuardOverride(PARENT, {}, checkOverrideFn);
    expect(result).toEqual({ active: true, source: "env" });
  });

  it("end-to-end with the real checkOverride: MINSKY_HOOK_OVERRIDE=duplicate-child-matcher resolves source 'env'", () => {
    const result = resolveDuplicateGuardOverride(PARENT, {
      MINSKY_HOOK_OVERRIDE: "duplicate-child-matcher",
    });
    expect(result).toEqual({ active: true, source: "env" });
  });
});

describe("decideTasksCreateGuard (mt#1435)", () => {
  // ACTIVE status: since mt#2683 the block path requires a non-terminal
  // sibling — terminal (DONE/CLOSED/COMPLETED) siblings warn instead.
  const children = [child("mt#2397", RAIL_TITLE, "TODO")];
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
      { parent: "mt#2370", title: RAIL_VARIANT_TITLE },
      { fetchChildren: fetchOk, overrideActive: false }
    );
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.message).toContain("mt#2397");
  });

  it("permits when no child overlaps", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: NON_OVERLAPPING_TITLE },
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
      { parent: "mt#2370", title: RAIL_VARIANT_TITLE },
      { fetchChildren: fetchOk, overrideActive: true }
    );
    expect(d.action).toBe("override");
    if (d.action === "override") expect(d.auditMatch).toBe("mt#2397");
  });

  it("override reports 'none' when there is no would-be duplicate", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: NON_OVERLAPPING_TITLE },
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

describe("decideTasksCreateGuard terminal-sibling WARN (mt#2683)", () => {
  it("warns (not blocks) when the only match is a terminal sibling", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: RAIL_VARIANT_TITLE },
      { fetchChildren: () => [child("mt#2397", RAIL_TITLE, "DONE")], overrideActive: false }
    );
    expect(d.action).toBe("warn");
    if (d.action === "warn") {
      expect(d.message).toContain("mt#2397");
      expect(d.message).toContain("[DONE]");
      expect(d.message).toContain("does NOT block");
    }
  });

  it("an ACTIVE match takes precedence over a terminal one", () => {
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: RAIL_VARIANT_TITLE },
      {
        fetchChildren: () => [
          child("mt#2397", RAIL_TITLE, "DONE"),
          child("mt#2399", RAIL_TITLE, "IN-PROGRESS"),
        ],
        overrideActive: false,
      }
    );
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.message).toContain("mt#2399");
  });

  it("CLOSED and COMPLETED are terminal too", () => {
    for (const status of ["CLOSED", "COMPLETED"]) {
      const d = decideTasksCreateGuard(
        { parent: "mt#2370", title: RAIL_VARIANT_TITLE },
        { fetchChildren: () => [child("mt#2397", RAIL_TITLE, status)], overrideActive: false }
      );
      expect(d.action).toBe("warn");
    }
  });
});

describe("lazy parent-title fetch (mt#2683)", () => {
  it("does not fetch the parent title when no candidate match exists", () => {
    let calls = 0;
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: NON_OVERLAPPING_TITLE },
      {
        fetchChildren: () => [child("mt#2397", RAIL_TITLE, "TODO")],
        overrideActive: false,
        fetchParentTitle: () => {
          calls++;
          return "anything";
        },
      }
    );
    expect(d.action).toBe("permit");
    expect(calls).toBe(0);
  });

  it("fetches at most once even when both pools have candidates", () => {
    let calls = 0;
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: RAIL_VARIANT_TITLE },
      {
        fetchChildren: () => [
          child("mt#2397", RAIL_TITLE, "TODO"),
          child("mt#2398", RAIL_TITLE, "DONE"),
        ],
        overrideActive: false,
        fetchParentTitle: () => {
          calls++;
          return null;
        },
      }
    );
    expect(d.action).toBe("block");
    expect(calls).toBe(1);
  });

  it("override path never fetches the parent title and reports the undiscounted match (PR #1859 R1)", () => {
    let calls = 0;
    const d = decideTasksCreateGuard(
      { parent: "mt#2370", title: RAIL_VARIANT_TITLE },
      {
        fetchChildren: () => [child("mt#2397", RAIL_TITLE, "TODO")],
        overrideActive: true,
        fetchParentTitle: () => {
          calls++;
          return "anything";
        },
      }
    );
    expect(d.action).toBe("override");
    if (d.action === "override") expect(d.auditMatch).toBe("mt#2397");
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mt#2683 incident replays — the REAL titles from the two 2026-07-08 false
// positives that motivated the matcher tuning.
// ---------------------------------------------------------------------------

describe("mt#2683 incident replay: mt#2581 decomposition vs DONE ADR sibling", () => {
  const PARENT_TITLE =
    "Transcript storage: derive-don't-duplicate (on-disk JSONL = system of record, DB = rebuildable derived index)";
  const DONE_ADR_SIBLING = child(
    "mt#2582",
    "Author ADR: transcript storage — object-store raw archive is system-of-record, Postgres is derived index",
    "DONE"
  );
  const deps = {
    fetchChildren: () => [DONE_ADR_SIBLING],
    overrideActive: false,
    fetchParentTitle: () => PARENT_TITLE,
  };
  const ARCHIVE_TITLE =
    "Transcript raw archive: private Supabase Storage bucket + domain archive client (ADR-025 foundation)";
  const INGEST_TITLE = "Transcript ingest rewrite: upload-then-parse (archive-first capture)";
  const BACKFILL_TITLE =
    "Backfill: archive existing agent_transcripts blobs to object storage (pre-drop gate)";
  const BLOCKED_TITLES = [ARCHIVE_TITLE, INGEST_TITLE, BACKFILL_TITLE];

  it("none of the three genuinely-distinct children BLOCK anymore", () => {
    for (const title of BLOCKED_TITLES) {
      const d = decideTasksCreateGuard({ parent: "mt#2581", title }, deps);
      expect(d.action).not.toBe("block");
    }
  });

  it("the backfill title (2 counted tokens vs the DONE sibling) warns instead of blocking", () => {
    const d = decideTasksCreateGuard({ parent: "mt#2581", title: BACKFILL_TITLE }, deps);
    expect(d.action).toBe("warn");
    if (d.action === "warn") {
      expect(d.message).toContain("mt#2582");
      expect(d.message).toContain("[DONE]");
    }
  });

  it("a true near-duplicate of an ACTIVE sibling still blocks despite the discount", () => {
    const activeSibling = child("mt#2680", ARCHIVE_TITLE, "TODO");
    const d = decideTasksCreateGuard(
      {
        parent: "mt#2581",
        title: "Transcript raw archive: Supabase Storage bucket + archive client",
      },
      { ...deps, fetchChildren: () => [activeSibling] }
    );
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.message).toContain("mt#2680");
  });
});

describe("mt#2683 incident replay: mt#2686 filing vs TODO sibling mt#2523", () => {
  it("only 'code' survives the parent discount ('conversation' is epic vocabulary) — permits", () => {
    const d = decideTasksCreateGuard(
      {
        parent: "mt#2522",
        title:
          "ADR-022 stage 1: workspace/conversation vocabulary in new code, docs convention, and cockpit routes (+ ADR flip to Accepted)",
      },
      {
        fetchChildren: () => [
          child(
            "mt#2523",
            "Find and resume a past Claude Code conversation (content search to --resume id)",
            "TODO"
          ),
        ],
        overrideActive: false,
        fetchParentTitle: () =>
          "Epic: session vs. conversation — findability, id-safety, and terminology",
      }
    );
    expect(d.action).toBe("permit");
  });
});

// ---------------------------------------------------------------------------
// Acceptance test (mt#2658 spec): full pipeline — resolveDuplicateGuardOverride
// (real checkOverride) -> decideTasksCreateGuard, backed by an in-memory grant
// list via the real findValidGuardGrant matcher. No fs is touched: checkOverride's
// `findGuardGrant` is injected with a closure over an in-memory GuardGrant[].
// ---------------------------------------------------------------------------

describe("mt#2658 acceptance test: fresh grant permits, expired grant denies", () => {
  const PARENT = "mt#2581";
  const NEW_TITLE = RAIL_VARIANT_TITLE; // token-overlapping-but-distinct
  // ACTIVE status: the expired-grant case asserts the BLOCK path, which since
  // mt#2683 requires a non-terminal sibling.
  const children = [child("mt#2397", RAIL_TITLE, "TODO")]; // RAIL_TITLE shares >=2 tokens
  const fetchOk = () => children;
  const REASON = "concurrent decomposition — distinct sibling, not a duplicate";

  function makeGrant(overrides: Partial<GuardGrant> = {}): GuardGrant {
    return {
      guardName: DUPLICATE_CHILD_GUARD_NAME,
      scope: PARENT,
      issuedAt: "2026-07-08T00:00:00.000Z",
      ttlMs: 30 * 60 * 1000, // 30 minutes
      reason: REASON,
      ...overrides,
    };
  }

  it("fresh (unexpired) grant: token-overlapping-but-distinct child files successfully, reason lands in the resolution", () => {
    const grants = [makeGrant()];
    const nowMs = Date.parse("2026-07-08T00:05:00.000Z"); // 5 min after issuance — well within TTL

    const overrideResolution = resolveDuplicateGuardOverride(
      PARENT,
      {},
      (guardName, env, options) =>
        checkOverride(guardName, env, {
          ...options,
          now: () => nowMs,
          findGuardGrant: (gName, scope, ms) =>
            findValidGuardGrant(grants, { guardName: gName, scope }, ms),
        })
    );

    expect(overrideResolution).toEqual({
      active: true,
      source: "grant",
      reason: REASON,
    });

    const decision = decideTasksCreateGuard(
      { parent: PARENT, title: NEW_TITLE },
      { fetchChildren: fetchOk, overrideActive: overrideResolution.active }
    );

    // "files successfully" — the guard does not block; it reports the
    // would-be match for audit (the standard override-decision shape).
    expect(decision.action).toBe("override");
    if (decision.action === "override") expect(decision.auditMatch).toBe("mt#2397");
  });

  it("expired grant: the guard denies as today (block, same as with no grant at all)", () => {
    const grants = [makeGrant()];
    // 31 minutes after issuance — 1 minute past the 30-minute TTL.
    const nowMs = Date.parse("2026-07-08T00:31:00.000Z");

    const overrideResolution = resolveDuplicateGuardOverride(
      PARENT,
      {},
      (guardName, env, options) =>
        checkOverride(guardName, env, {
          ...options,
          now: () => nowMs,
          findGuardGrant: (gName, scope, ms) =>
            findValidGuardGrant(grants, { guardName: gName, scope }, ms),
        })
    );

    expect(overrideResolution).toEqual({ active: false });

    const decision = decideTasksCreateGuard(
      { parent: PARENT, title: NEW_TITLE },
      { fetchChildren: fetchOk, overrideActive: overrideResolution.active }
    );

    expect(decision.action).toBe("block");
    if (decision.action === "block") expect(decision.message).toContain("mt#2397");
  });
});
