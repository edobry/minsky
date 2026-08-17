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
  decideOutcome,
  findDesignSkillsInvoked,
  normalizeSkillName,
  extractSkillNames,
  isSkillToolName,
  buildDesignPassWarning,
  run,
  DESIGN_SKILLS,
  MAX_REPORTED_SURFACES,
  OVERRIDE_ENV_VAR,
} from "./new-surface-design-pass";
import { CANARY_MODE_ENV } from "./types";
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

  test("EXTRACTION applies the normalizer too, not just the exported predicate", () => {
    // PR #3030 R1 (BLOCKING). The first version called `findToolUseInputs(lines,
    // "Skill")`, which compares the tool name with `===` — so `isSkillToolName`
    // existed, was exported, was tested, and was not on the path that decides
    // anything. A skill call spelled any other way was invisible, and an
    // invisible skill call reads as "no design pass": a FALSE FIRE.
    const spellings = ["Skill", "skill", "mcp__minsky__Skill"];
    for (const toolName of spellings) {
      const line = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: toolName, input: { skill: "cockpit-design" } }],
        },
      } as TranscriptLine;
      expect(extractSkillNames([line])).toEqual(["cockpit-design"]);
    }
  });

  test("reads the TOP-LEVEL tool_use line shape as well as the nested one", () => {
    // Handling only the nested shape made top-level-recorded turns invisible in a
    // sibling detector (PR #2584 R1). Same corpus, same hazard.
    const topLevel = {
      type: "tool_use",
      name: "Skill",
      input: { skill: "impeccable" },
    } as unknown as TranscriptLine;
    expect(extractSkillNames([topLevel])).toEqual(["impeccable"]);
  });

  test("a non-Skill tool carrying a `skill` field is not counted", () => {
    // The discriminating direction: without the tool-name check, any tool whose
    // input happened to have a `skill` key would discharge the guard.
    const line = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Task", input: { skill: "impeccable" } }],
      },
    } as TranscriptLine;
    expect(extractSkillNames([line])).toEqual([]);
  });
});

describe("decideOutcome — the shell's branches (mt#4124, PR #3030 R1)", () => {
  const applicable = {
    applicable: true as const,
    addedSurfaces: [PEEK_HOST],
    designSkillsInvoked: [],
  };

  test("an ABSENT transcript is `skipped`, never `matched`", () => {
    // The load-bearing rule of the whole module, and previously assertable only
    // by mocking IO. "I could not look" is not "it did not happen": this guard's
    // entire discriminator is session state, so with no session state there is
    // no finding — and concluding otherwise would fire on every transcript-less
    // invocation.
    const outcome = decideOutcome(applicable, false);
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" && outcome.reason).toContain("no transcript");
  });

  test("applicable + transcript + no design skill is `matched`", () => {
    expect(decideOutcome(applicable, true).kind).toBe("matched");
  });

  test("applicable + a design skill is `clean`", () => {
    expect(
      decideOutcome({ ...applicable, designSkillsInvoked: ["cockpit-design"] }, true).kind
    ).toBe("clean");
  });

  test("not applicable is `clean`, and stays clean with no transcript", () => {
    // Order matters: applicability is checked BEFORE the transcript, so a PR that
    // adds no surface is a clean pass rather than an unmeasurable skip. Recording
    // it as `skipped` would inflate the unmeasurable rate with cases the guard
    // answered perfectly well.
    const notApplicable = {
      applicable: false as const,
      addedSurfaces: [],
      designSkillsInvoked: [],
    };
    expect(decideOutcome(notApplicable, true).kind).toBe("clean");
    expect(decideOutcome(notApplicable, false).kind).toBe("clean");
  });
});

describe("run() — the short-circuit paths (mt#4124, PR #3030 R1)", () => {
  const input = { session_id: "s1", tool_name: "mcp__minsky__session_pr_create" } as never;
  const ctx = { transcriptLines: [] } as never;

  test("the override returns null — a silent allow, not a recorded skip", () => {
    // An overridden guard must produce NO calibration record: a record would
    // pollute the fire-rate denominator with runs the operator turned off.
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      expect(run(input, ctx)).resolves.toBeNull();
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });

  test("canary mode records a SKIP without touching the tree or the transcript", async () => {
    // mt#3824 R2: a canary must never depend on the state of a real working tree,
    // and whether the canary process has one is environment state this module
    // does not control. The healthy canary outcome is therefore a RECORDED skip.
    process.env[CANARY_MODE_ENV] = "1";
    try {
      const outcome = await run(input, ctx);
      expect(outcome?.calibration?.["outcome"]).toBe("skipped");
      expect(String(outcome?.calibration?.["reason"])).toContain("canary");
      // Never denies, never advises — the posture, asserted rather than intended.
      expect(outcome?.additionalContext).toBeUndefined();
    } finally {
      delete process.env[CANARY_MODE_ENV];
    }
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
