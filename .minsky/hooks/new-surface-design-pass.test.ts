// mt#4124 — the artifact-vs-judgment discriminator.
//
// The load-bearing test is the WORKED EXAMPLE: PR #2942's real added-file set and
// its real skill-invocation list must FLAG, where mt#2421's existing artifact
// check passes on the same PR. That contrast is what the task exists to
// establish, so it is asserted here rather than described.
//
// The second load-bearing test is the ABSENT-TRANSCRIPT case. This guard's whole
// discriminator is session state, so a run with no session state must record a
// SKIP, never a fire — "I could not look" is not "it did not happen", and a guard
// that conflates them fires on every transcript-less invocation.

import { describe, test, expect } from "bun:test";
import {
  checkNewSurfaceDesignPass,
  findDesignSkillsInvoked,
  normalizeSkillName,
  extractSkillNames,
  isSkillToolName,
  buildDesignPassWarning,
  DESIGN_SKILLS,
  MAX_REPORTED_SURFACES,
} from "./new-surface-design-pass";
import type { TranscriptLine } from "./transcript";

/**
 * PR #2942's real additions, from the mt#4124 planning replay. Three render-path
 * files plus a non-render addition, so the filter is exercised rather than
 * assumed.
 */
const PEEK_HOST = "src/cockpit/web/components/PeekHost.tsx";

const PR_2942_ADDED = [
  "src/cockpit/web/components/PeekBody.tsx",
  PEEK_HOST,
  "src/cockpit/web/components/ui/sheet.tsx",
  "src/cockpit/web/lib/peek-codec.ts",
];

/**
 * Every skill invoked in PR #2942's authoring conversation
 * (`93e98f39-ab98-47e5-b04b-82b17165f3ad`), extracted at planning time. No design
 * skill of any kind.
 */
const PR_2942_SKILLS = ["plan-task", "plan-task", "implement-task", "retrospective", "handoff"];

function skillCall(name: string): TranscriptLine {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Skill", input: { skill: name } }],
    },
  } as TranscriptLine;
}

describe("the PR #2942 worked example (mt#4124)", () => {
  test("FLAGS: three added surfaces, five skills, none of them design", () => {
    const result = checkNewSurfaceDesignPass(PR_2942_ADDED, PR_2942_SKILLS);

    expect(result.applicable).toBe(true);
    expect(result.designSkillsInvoked).toEqual([]);
    // The non-render addition is excluded — `.ts` under the same tree is lib
    // code whose correctness a unit test CAN settle.
    expect(result.addedSurfaces).toEqual([
      "src/cockpit/web/components/PeekBody.tsx",
      PEEK_HOST,
      "src/cockpit/web/components/ui/sheet.tsx",
    ]);
  });

  test("would NOT have flagged had a design skill run — the discriminator discriminates", () => {
    // The counterfactual control. Without it, the test above is compatible with a
    // check that flags every render-path addition regardless of skill calls,
    // which would carry no information on the axis this task is about (mem#704).
    const result = checkNewSurfaceDesignPass(PR_2942_ADDED, [...PR_2942_SKILLS, "cockpit-design"]);

    expect(result.applicable).toBe(true);
    expect(result.designSkillsInvoked).toEqual(["cockpit-design"]);
  });
});

describe("the ADDED-only narrowing (mt#4124)", () => {
  test("a branch that only MODIFIES a render path is not applicable", () => {
    // The shell passes only status-`A` paths, so an edit-only branch arrives here
    // as an empty list. This pins the contract between the two halves: a one-line
    // CSS tweak must never demand a design pass.
    expect(checkNewSurfaceDesignPass([], PR_2942_SKILLS).applicable).toBe(false);
  });

  test("a branch adding only non-render files is not applicable", () => {
    const result = checkNewSurfaceDesignPass(
      [".minsky/hooks/new-surface-design-pass.ts", "docs/architecture/hooks/whatever.md"],
      []
    );
    expect(result.applicable).toBe(false);
    expect(result.addedSurfaces).toEqual([]);
  });

  test("an added cockpit TEST file is not a new surface", () => {
    // `isRenderPathFile` excludes test files; a PR that only adds `Foo.test.tsx`
    // changes no rendered surface and firing on it would be pure noise.
    const result = checkNewSurfaceDesignPass(["src/cockpit/web/components/Foo.test.tsx"], []);
    expect(result.applicable).toBe(false);
  });
});

describe("skill-name normalization (mt#4124)", () => {
  test("accepts the three spellings the harness takes for one skill", () => {
    expect(normalizeSkillName("impeccable")).toBe("impeccable");
    expect(normalizeSkillName("/impeccable")).toBe("impeccable");
    expect(normalizeSkillName("plugin:impeccable")).toBe("impeccable");
    expect(normalizeSkillName("  Impeccable  ")).toBe("impeccable");
  });

  test("every enumerated design skill is recognized", () => {
    for (const skill of DESIGN_SKILLS) {
      expect(findDesignSkillsInvoked([skill])).toEqual([skill]);
    }
  });

  test("a non-design skill is not recognized, and near-misses do not count", () => {
    // `design` is a substring of `cockpit-design`; matching on containment rather
    // than equality would let an unrelated skill discharge the check.
    expect(findDesignSkillsInvoked(["implement-task", "design", "designer"])).toEqual([]);
  });

  test("repeated invocations of one skill collapse", () => {
    expect(findDesignSkillsInvoked(["impeccable", "/impeccable", "impeccable"])).toEqual([
      "impeccable",
    ]);
  });
});

describe("transcript extraction (mt#4124)", () => {
  test("reads the skill name out of Skill tool_use blocks", () => {
    const lines = [skillCall("cockpit-design"), skillCall("implement-task")];
    expect(extractSkillNames(lines)).toEqual(["cockpit-design", "implement-task"]);
  });

  test("an empty transcript yields no skill names", () => {
    // The value the shell keys its SKIP on — asserted here so the shell's
    // absent-transcript branch rests on a pinned behavior rather than an
    // assumption about what an empty list means.
    expect(extractSkillNames([])).toEqual([]);
  });

  test("a Skill call with no skill param is ignored rather than counted", () => {
    const malformed = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: {} }],
      },
    } as TranscriptLine;
    expect(extractSkillNames([malformed])).toEqual([]);
  });

  test("the tool name is matched through the shared normalizer", () => {
    expect(isSkillToolName("Skill")).toBe(true);
    expect(isSkillToolName("skill")).toBe(true);
    expect(isSkillToolName("mcp__minsky__skill")).toBe(true);
    expect(isSkillToolName("Task")).toBe(false);
  });
});

describe("the warning (mt#4124)", () => {
  test("names the guard, the surfaces, the remedy and the override", () => {
    const warning = buildDesignPassWarning([PEEK_HOST]);

    expect(warning).toContain("[new-surface-design-pass]");
    expect(warning).toContain(PEEK_HOST);
    expect(warning).toContain("/cockpit-design");
    expect(warning).toContain("MINSKY_SKIP_NEW_SURFACE_DESIGN_PASS=1");
    // Log-only posture must be legible in the message itself: a reader who takes
    // an advisory for a block is the failure this label prevents.
    expect(warning).toContain("CALIBRATION (log-only");
  });

  test("states the overflow rather than silently truncating", () => {
    const many = Array.from(
      { length: MAX_REPORTED_SURFACES + 3 },
      (_, i) => `src/cockpit/web/components/S${i}.tsx`
    );
    const warning = buildDesignPassWarning(many);

    expect(warning).toContain("... and 3 more");
    expect(warning).toContain("src/cockpit/web/components/S0.tsx");
    // A silent cap reads as "these are all of them" — the mt#4096 shape.
    expect(warning).not.toContain(`src/cockpit/web/components/S${MAX_REPORTED_SURFACES}.tsx`);
  });
});
