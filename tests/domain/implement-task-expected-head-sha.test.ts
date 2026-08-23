// mt#4046: `/implement-task` §9's `expectedHeadSha` guidance must state ONE rule —
// "the head of whichever call LAST PUSHED" — and must not revert to the single-source
// wording it carried before.
//
// Why a test over prose. The prior text said to take the sha from `session_commit`'s
// returned `commitHash`. That is correct for a fix round and wrong for the first wait,
// because `session_pr_create` pushes a head of its own. Five sessions in five days
// followed it and each burned a full 10-15 minute watcher timeout while a real review
// sat suppressed (PRs #2920, #2966, #2980, #3000, #3013). The failure is silent — it
// reads as reviewer silence, which is the documented lead-in to a bypass — so nothing
// downstream catches a regression here.
//
// It also asserts the GENERATED artifact, not only the source, following
// tests/domain/plan-task-gate-letters.test.ts. A source edit that is never recompiled
// leaves every agent reading the old text, and mt#2091's gate was silently deleted by
// exactly that class of drift.

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify the
   generated artifact on disk carries the same rule as its source, so it must read the
   real file. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import implementTaskSkill from "../../.minsky/skills/implement-task/skill.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

const SURFACES: Array<{ name: string; content: () => string }> = [
  {
    name: ".minsky/skills/implement-task/skill.ts (source)",
    content: () => implementTaskSkill.content as string,
  },
  {
    name: ".claude/skills/implement-task/SKILL.md (generated)",
    content: () =>
      readFileSync(join(REPO_ROOT, ".claude/skills/implement-task/SKILL.md"), "utf8") as string,
  },
];

describe("implement-task §9 expectedHeadSha rule (mt#4046)", () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      test("states the last-pushed rule", () => {
        // The policy sentence itself. Deliberately an exact substring: rewording it
        // should require touching this file, which puts the change in front of a human.
        expect(surface.content()).toContain("it is the head of whichever call LAST PUSHED");
      });

      test("names session_pr_create's headSha as the first wait's source", () => {
        const content = surface.content();
        expect(content).toContain("headSha");
        expect(content).toContain("session_pr_create");
      });

      test("does not tell the reader to take the sha from session_commit unconditionally", () => {
        // The exact wording that produced all five occurrences. Its absence is the
        // regression guard; the table above it is what replaced it.
        expect(surface.content()).not.toContain(
          "Take the sha from `session_commit`'s returned `commitHash`"
        );
      });
    });
  }
});
