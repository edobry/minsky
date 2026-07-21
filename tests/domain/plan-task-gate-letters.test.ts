// mt#2964: structural guardrail for the /plan-task gate battery.
//
// mt#2445 reused gate letter (l) for the authoritative-source gate and thereby
// SILENTLY DELETED mt#2091's problem-statement gate that had held (l). There was
// NO duplicate letter — the reused letter simply replaced the prior gate's
// content — so a naive "no duplicate letters" check would NOT have caught it
// (reviewer PR #2114 R1). The real invariant is a MANIFEST: every gate that has
// shipped must remain present, at its own letter, and the letters must be the
// exact append-only sequence. This test enforces that manifest against BOTH the
// source skill definition AND the generated .claude/skills/plan-task/SKILL.md
// that agents actually consume (which also catches a stale/broken compile).

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify
   the generated .claude/skills/plan-task/SKILL.md artifact on disk matches the
   source manifest, so it must read the real generated file. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import planTaskSkill from "../../.minsky/skills/plan-task/skill.ts";

// The append-only gate-letter manifest: [letter, exact heading title], in order.
// Letter (i) is permanently skipped (reserved for the Step 2.5 premise-audit
// roman numerals). Adding a gate = APPEND a new row at the next free letter;
// NEVER reuse or reword a letter's row without a deliberate manifest update.
// The intentional brittleness IS the guard: a silent gate change fails this test.
const EXPECTED_GATES: string[][] = [
  ["a", "Required spec sections present"],
  ["b", "Success criteria are testable"],
  ["c", "Scope is bounded"],
  ["d", "No blocking questions"],
  ["e", "File:line references are fresh"],
  ["f", "Subtasks filed for multi-phase work"],
  ["g", "No parallel work in flight"],
  ["h", "Contract-propagation enumeration"],
  ["j", "Premise label verification"],
  ["k", "Third-party tool/dependency verification"],
  ["l", "Authoritative-source check for third-party-system decisions"],
  ["m", "Factual-claim citation verification"],
  ["n", "External-system integration provisioning enumeration"],
  ["o", "Problem-statement verification"],
];

// Tolerant of leading whitespace + em/en/hyphen dash variants (reviewer nit R1).
const GATE_HEADING = /^[ \t]*#### Gate criterion \(([a-z])\)\s*[—–-]\s*(.+?)\s*$/gm;

function parseGates(content: string): string[][] {
  return [...content.matchAll(GATE_HEADING)].map((m) => [m[1] as string, m[2] as string]);
}

const GENERATED_SKILL_PATH = join(import.meta.dir, "../../.claude/skills/plan-task/SKILL.md");

describe("plan-task gate-letter manifest (mt#2964)", () => {
  test("source skill defines exactly the expected gates, in order (append-only — no reuse, no deletion, no reorder)", () => {
    expect(parseGates(planTaskSkill.content)).toEqual(EXPECTED_GATES);
  });

  test("generated SKILL.md (what agents consume) matches the same manifest (also catches a stale compile)", () => {
    const generated = readFileSync(GENERATED_SKILL_PATH, "utf8") as string;
    expect(parseGates(generated)).toEqual(EXPECTED_GATES);
  });

  test("the restored problem-statement gate (o) requires reproducing the asserted failure", () => {
    expect(planTaskSkill.content).toMatch(/reproduce the asserted failure/i);
  });
});
