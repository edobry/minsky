// mt#5133: /handoff step 8 branches on whether the conversation holds a package —
// succeed it (`tasks.package.succeed`, mint nothing) or mint one (`tasks_create`).
//
// Two jobs, the same shape as create-task-claim-steps.test.ts:
//
//  1. TEXT INVARIANT — the branch is present in BOTH the source skill and the
//     generated `.claude/skills/handoff/SKILL.md` agents actually consume, and
//     the continuation guidance routes a successor to `## Transfers` first.
//     ADR-046 decision 3 was accepted 2026-08-30 and the skill contradicted it
//     until 2026-09-13; this pins the repair against a silent regression.
//
//  2. ACCEPTANCE REPLAY (AT3) — "from a conversation that claimed a package →
//     succeed; from one that did not → create". `selectHandoffPackageWrite`
//     encodes the branch so the AT is executable; it is a TEST HARNESS for the
//     prose step, not a shipped guard.

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify the
   generated .claude/skills/handoff/SKILL.md artifact on disk matches the source. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_SKILL_PATH = join(import.meta.dir, "../../.minsky/skills/handoff/SKILL.md");
const GENERATED_SKILL_PATH = join(import.meta.dir, "../../.claude/skills/handoff/SKILL.md");

const SOURCE = readFileSync(SOURCE_SKILL_PATH, "utf8") as string;
const GENERATED = readFileSync(GENERATED_SKILL_PATH, "utf8") as string;

const SUCCEED_TOOL = "mcp__minsky__tasks_package_succeed";
const CREATE_TOOL = "mcp__minsky__tasks_create";

/** The text of `### 8.` up to the next `### ` heading. */
function step8(text: string): string {
  const start = text.search(/^### 8\. /m);
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const next = rest.slice(4).search(/^### /m);
  return next === -1 ? rest : rest.slice(0, next + 4);
}

/** The `## Continuation guidance` section's step 1. */
function continuationStep1(text: string): string {
  // The heading, not the prose mentions of it earlier in the file.
  const start = text.search(/^## Continuation guidance/m);
  expect(start).toBeGreaterThan(-1);
  const section = text.slice(start);
  const s1 = section.search(/^1\. /m);
  const s2 = section.search(/^2\. /m);
  expect(s1).toBeGreaterThan(-1);
  expect(s2).toBeGreaterThan(s1);
  return section.slice(s1, s2);
}

/**
 * The step-8 decision, as the skill states it: a conversation that claimed a
 * package succeeds THAT package; one that claimed nothing mints a new one.
 */
export function selectHandoffPackageWrite(input: {
  claimedPackageId: string | null;
}): { write: "succeed"; taskId: string } | { write: "create" } {
  return input.claimedPackageId
    ? { write: "succeed", taskId: input.claimedPackageId }
    : { write: "create" };
}

describe("/handoff step 8 succession branch (mt#5133)", () => {
  for (const [label, text] of [
    ["source", SOURCE],
    ["generated", GENERATED],
  ] as const) {
    test(`${label}: step 8 names both writes and binds each to its condition`, () => {
      const s8 = step8(text);
      expect(s8).toContain(SUCCEED_TOOL);
      expect(s8).toContain(CREATE_TOOL);
      expect(s8).toMatch(/CLAIMED a work package[\s\S]*tasks_package_succeed/);
      expect(s8).toMatch(/claimed nothing[\s\S]*tasks_create/);
      expect(s8).toContain("mint nothing");
      expect(s8).toContain("There is no predecessor to close");
      // The status set is create-only: succession's release already returns the package to READY.
      expect(s8).toMatch(/On the CREATE branch, then call `mcp__minsky__tasks_status_set`/);
    });

    test(`${label}: continuation step 1 sends the successor to ## Transfers before the members`, () => {
      const s1 = continuationStep1(text);
      expect(s1).toContain("## Transfers");
      expect(s1).toMatch(/prior transfers/);
      const thenMembers = s1.search(/then\s+the members/);
      expect(thenMembers).toBeGreaterThan(-1);
      expect(s1.indexOf("## Transfers")).toBeLessThan(thenMembers);
    });
  }

  test("generated skill body matches the source (compile is the only writer)", () => {
    expect(step8(GENERATED)).toBe(step8(SOURCE));
    expect(continuationStep1(GENERATED)).toBe(continuationStep1(SOURCE));
  });

  test("AT3 replay: a claimed package → succeed that package; nothing claimed → create", () => {
    expect(selectHandoffPackageWrite({ claimedPackageId: "mt#5119" })).toEqual({
      write: "succeed",
      taskId: "mt#5119",
    });
    expect(selectHandoffPackageWrite({ claimedPackageId: null })).toEqual({ write: "create" });
  });
});
