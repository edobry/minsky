// mt#2964: structural guardrail for the /plan-task gate battery.
//
// mt#2445 reused gate letter (l) for the authoritative-source gate and silently
// DELETED mt#2091's problem-statement gate that had held (l) — the loss went
// unnoticed until mt#2958 (a multi-hour misdiagnosis the deleted gate would have
// prevented). This test enforces the append-only-letter invariant (no two gate
// criteria share a letter) plus the presence of the restored gate (o), so a
// future edit cannot clobber a shipped gate the same way again.

import { describe, test, expect } from "bun:test";
import planTaskSkill from "../../.minsky/skills/plan-task/skill.ts";

/** Extract the ordered list of `#### Gate criterion (X)` letters from the skill body. */
function gateLetters(content: string): string[] {
  return [...content.matchAll(/^#### Gate criterion \(([a-z])\)/gm)].map((m) => m[1] as string);
}

describe("plan-task gate-letter invariants (mt#2964)", () => {
  test("no two gate criteria share a letter (append-only invariant)", () => {
    const letters = gateLetters(planTaskSkill.content);
    expect(letters.length).toBeGreaterThan(0);
    const duplicates = letters.filter((letter, i) => letters.indexOf(letter) !== i);
    expect(duplicates).toEqual([]);
  });

  test("the restored problem-statement-verification gate (o) is present (mt#2091 -> mt#2964)", () => {
    expect(planTaskSkill.content).toContain(
      "#### Gate criterion (o) — Problem-statement verification"
    );
    // and it actually requires reproducing the asserted failure, not just naming the gate
    expect(planTaskSkill.content).toMatch(/reproduce the asserted failure/i);
  });

  test("letter (i) is deliberately skipped (reserved for the premise-audit roman numerals)", () => {
    expect(gateLetters(planTaskSkill.content)).not.toContain("i");
  });
});
