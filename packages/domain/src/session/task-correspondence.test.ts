// Tests for the PR-task correspondence detector (mt#2514, Seam 2 of mt#2511).

import { describe, it, expect } from "bun:test";
import {
  normalizeTaskId,
  extractTaskRefs,
  detectTaskCorrespondenceMismatch,
  isTaskHijackOverride,
  evaluateTaskCorrespondence,
  buildHijackBlockMessage,
  TASK_HIJACK_OVERRIDE_ENV,
} from "./task-correspondence";

describe("normalizeTaskId", () => {
  it("collapses separators and case", () => {
    expect(normalizeTaskId("mt#2514")).toBe("mt2514");
    expect(normalizeTaskId("MT#2514")).toBe("mt2514");
    expect(normalizeTaskId("mt-2514")).toBe("mt2514");
    expect(normalizeTaskId("mt2514")).toBe("mt2514");
  });
  it("returns empty for non-string/empty", () => {
    expect(normalizeTaskId(undefined)).toBe("");
    expect(normalizeTaskId(2514)).toBe("");
    expect(normalizeTaskId("")).toBe("");
  });
});

describe("extractTaskRefs", () => {
  it("extracts known-backend refs in # and - forms", () => {
    expect(extractTaskRefs("feat(mt#2514): add guard")).toEqual(["mt2514"]);
    expect(extractTaskRefs("Merge branch 'task/mt-2514'")).toEqual(["mt2514"]);
    expect(extractTaskRefs("fix(md#7): doc; refs gh#19")).toEqual(["md7", "gh19"]);
  });
  it("ignores incidental xx-NNNN tokens (unknown backend)", () => {
    expect(extractTaskRefs("bump co-2024 calendar and v2-handler")).toEqual([]);
  });
  it("handles no refs / non-string", () => {
    expect(extractTaskRefs("chore: tidy imports")).toEqual([]);
    expect(extractTaskRefs(undefined)).toEqual([]);
  });
});

describe("detectTaskCorrespondenceMismatch", () => {
  it("MISMATCH: commits reference a different task, none reference the bound task", () => {
    const v = detectTaskCorrespondenceMismatch(
      ["feat(mt#999): deck slides", "chore(mt#999): polish"],
      "mt#2514"
    );
    expect(v.mismatch).toBe(true);
    expect(v.referencedTasks).toEqual(["mt999"]);
    expect(v.boundTask).toBe("mt2514");
  });
  it("no mismatch: at least one commit references the bound task", () => {
    const v = detectTaskCorrespondenceMismatch(
      ["feat(mt#2514): guard", "fix(mt#999): unrelated note"],
      "mt#2514"
    );
    expect(v.mismatch).toBe(false);
  });
  it("no mismatch: terse commits with no refs (conservative)", () => {
    expect(detectTaskCorrespondenceMismatch(["wip", "fix tests"], "mt#2514").mismatch).toBe(false);
  });
  it("no mismatch: empty bound task (can't compare)", () => {
    expect(detectTaskCorrespondenceMismatch(["feat(mt#999): x"], "").mismatch).toBe(false);
  });
  it("matches the bound task across separator forms (branch mt-2514 vs arg mt#2514)", () => {
    expect(
      detectTaskCorrespondenceMismatch(["Merge branch 'task/mt-2514'"], "mt#2514").mismatch
    ).toBe(false);
  });
});

describe("isTaskHijackOverride", () => {
  it("is true for 1/true/yes; false otherwise", () => {
    expect(isTaskHijackOverride({ [TASK_HIJACK_OVERRIDE_ENV]: "1" })).toBe(true);
    expect(isTaskHijackOverride({ [TASK_HIJACK_OVERRIDE_ENV]: "TRUE" })).toBe(true);
    expect(isTaskHijackOverride({ [TASK_HIJACK_OVERRIDE_ENV]: "yes" })).toBe(true);
    expect(isTaskHijackOverride({ [TASK_HIJACK_OVERRIDE_ENV]: "0" })).toBe(false);
    expect(isTaskHijackOverride({})).toBe(false);
  });
});

describe("buildHijackBlockMessage", () => {
  it("names the bound task, referenced tasks, and the override", () => {
    const msg = buildHijackBlockMessage(
      { mismatch: true, referencedTasks: ["mt999"], boundTask: "mt2514" },
      "mt#2514"
    );
    expect(msg).toContain("mt#2514");
    expect(msg).toContain("mt999");
    expect(msg).toContain(TASK_HIJACK_OVERRIDE_ENV);
  });
});

describe("evaluateTaskCorrespondence", () => {
  it("blocks (returns message) on a strong cross-task mismatch", async () => {
    const msg = await evaluateTaskCorrespondence({
      boundTaskId: "mt#2514",
      listCommitSubjects: async () => ["feat(mt#999): deck"],
      env: {},
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("mt#2514");
  });

  it("allows (null) when a commit references the bound task", async () => {
    const msg = await evaluateTaskCorrespondence({
      boundTaskId: "mt#2514",
      listCommitSubjects: async () => ["feat(mt#2514): guard"],
      env: {},
    });
    expect(msg).toBeNull();
  });

  it("allows (null) + audits when the override is set", async () => {
    const audits: string[] = [];
    const msg = await evaluateTaskCorrespondence({
      boundTaskId: "mt#2514",
      listCommitSubjects: async () => ["feat(mt#999): deck"], // would mismatch
      env: { [TASK_HIJACK_OVERRIDE_ENV]: "1" },
      onOverrideAudit: (l) => audits.push(l),
      nowIso: "2026-06-19T00:00:00.000Z",
    });
    expect(msg).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain(TASK_HIJACK_OVERRIDE_ENV);
  });

  it("fails open (null) when listing commits throws", async () => {
    const warns: string[] = [];
    const msg = await evaluateTaskCorrespondence({
      boundTaskId: "mt#2514",
      listCommitSubjects: async () => {
        throw new Error("GitHub 500");
      },
      env: {},
      log: { warn: (m) => warns.push(m) },
    });
    expect(msg).toBeNull();
    expect(warns[0]).toContain("fail-open");
  });

  it("fails open (null) when there is no bound task", async () => {
    let called = false;
    const msg = await evaluateTaskCorrespondence({
      boundTaskId: "",
      listCommitSubjects: async () => {
        called = true;
        return ["feat(mt#999): x"];
      },
      env: {},
    });
    expect(msg).toBeNull();
    expect(called).toBe(false); // short-circuits before fetching
  });
});
