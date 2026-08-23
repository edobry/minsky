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
  parseNameStatus,
  specDeclaresVisualJudgment,
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
    const result = checkNewSurfaceDesignPass(PR_2942_ADDED, [], PR_2942_SKILLS, false);

    expect(result.applicable).toBe(true);
    expect(result.designSkillsInvoked).toEqual([]);
    // The non-render addition is excluded — `.ts` under the same tree is lib
    // code whose correctness a unit test CAN settle.
    expect(result.surfaces).toEqual([
      "src/cockpit/web/components/PeekBody.tsx",
      PEEK_HOST,
      "src/cockpit/web/components/ui/sheet.tsx",
    ]);
  });

  test("would NOT have flagged had a design skill run — the discriminator discriminates", () => {
    // The counterfactual control. Without it, the test above is compatible with a
    // check that flags every render-path addition regardless of skill calls,
    // which would carry no information on the axis this task is about (mem#704).
    const result = checkNewSurfaceDesignPass(
      PR_2942_ADDED,
      [],
      [...PR_2942_SKILLS, "cockpit-design"],
      false
    );

    expect(result.applicable).toBe(true);
    expect(result.designSkillsInvoked).toEqual(["cockpit-design"]);
  });
});

describe("the ADDED-only narrowing (mt#4124)", () => {
  test("a branch that only MODIFIES a render path is not applicable", () => {
    // The shell passes only status-`A` paths, so an edit-only branch arrives here
    // as an empty list. This pins the contract between the two halves: a one-line
    // CSS tweak must never demand a design pass.
    expect(checkNewSurfaceDesignPass([], [], PR_2942_SKILLS, false).applicable).toBe(false);
  });

  test("a branch adding only non-render files is not applicable", () => {
    const result = checkNewSurfaceDesignPass(
      [".minsky/hooks/new-surface-design-pass.ts", "docs/architecture/hooks/whatever.md"],
      [],
      [],
      false
    );
    expect(result.applicable).toBe(false);
    expect(result.surfaces).toEqual([]);
  });

  test("an added cockpit TEST file is not a new surface", () => {
    // `isRenderPathFile` excludes test files; a PR that only adds `Foo.test.tsx`
    // changes no rendered surface and firing on it would be pure noise.
    const result = checkNewSurfaceDesignPass(
      ["src/cockpit/web/components/Foo.test.tsx"],
      [],
      [],
      false
    );
    expect(result.applicable).toBe(false);
  });
});

describe("trigger 2: a MODIFIED surface whose spec is visual (mt#4356)", () => {
  // The whole point of mt#4356. Every one of these inputs is drawn from mt#4251,
  // which modified exactly these two files, added none, and shipped a visual
  // treatment the principal then reported on.
  const MT_4251_MODIFIED = [
    "src/cockpit/web/components/ConversationElementRenderers.tsx",
    "src/cockpit/web/components/ConversationTurnView.tsx",
  ];

  test("FIRES on mt#4251's shape — the case the ADDED-only trigger could not see", () => {
    const result = checkNewSurfaceDesignPass([], MT_4251_MODIFIED, [], true);

    expect(result.applicable).toBe(true);
    expect(result.trigger).toBe("modified-surface-visual-spec");
    expect(result.surfaces).toEqual(MT_4251_MODIFIED);
  });

  test("does NOT fire on the same diff when the spec is not visual", () => {
    // The discriminator, isolated: identical files, identical skills, and the
    // ONLY difference is what the bound spec asks for. This is the false-positive
    // protection the original ADDED-only narrowing was written to provide, kept.
    const result = checkNewSurfaceDesignPass([], MT_4251_MODIFIED, [], false);

    expect(result.applicable).toBe(false);
    expect(result.trigger).toBeNull();
  });

  test("does not fire when a design skill DID run, visual spec or not", () => {
    const result = checkNewSurfaceDesignPass([], MT_4251_MODIFIED, ["/impeccable"], true);

    expect(result.applicable).toBe(true);
    expect(result.designSkillsInvoked).toEqual(["impeccable"]);
  });

  test("a renamed-AND-modified surface counts as modified (PR #3189 R1)", () => {
    // `git diff --name-status` emits `R<similarity>\told\tnew` for a rename, so
    // the shell has to read the THIRD field and split on the score. A component
    // moved and restyled in one branch is design work; the first draft dropped it
    // entirely, which left a silent hole inside the trigger this task added. The
    // shell's parse is covered here through the same contract the pure core sees:
    // an R<100 path arrives in `modifiedFiles`.
    const result = checkNewSurfaceDesignPass(
      [],
      ["src/cockpit/web/components/MovedAndRestyled.tsx"],
      [],
      true
    );

    expect(result.applicable).toBe(true);
    expect(result.trigger).toBe("modified-surface-visual-spec");
  });

  test("a modified NON-render file with a visual spec is still not applicable", () => {
    const result = checkNewSurfaceDesignPass([], [".minsky/hooks/whatever.ts"], [], true);
    expect(result.applicable).toBe(false);
  });

  test("an ADDED surface wins outright, so the shell can skip the spec fetch", () => {
    // Trigger 1 must not depend on `specIsVisual`: a new surface is a design
    // decision whatever the spec says, and the ordering is what lets `run()`
    // avoid a CLI round trip on that path.
    const result = checkNewSurfaceDesignPass(PR_2942_ADDED, MT_4251_MODIFIED, [], false);

    expect(result.applicable).toBe(true);
    expect(result.trigger).toBe("added-surface");
    expect(result.surfaces).not.toContain(MT_4251_MODIFIED[0]);
  });
});

describe("the spec visual-judgment discriminator (mt#4356)", () => {
  test("recognizes the criteria the four M-only visual specs actually used", () => {
    // Verbatim shapes from mt#4251 and mt#4348, not invented phrasings.
    expect(
      specDeclaresVisualJudgment(
        "- [ ] A screenshot at a realistic viewport showing rest and hover states is attached."
      )
    ).toBe(true);
    expect(
      specDeclaresVisualJudgment("Aesthetic acceptance is the principal's, not asserted in the PR.")
    ).toBe(true);
  });

  test("is case-folded", () => {
    expect(specDeclaresVisualJudgment("Screenshots at a 1440x900 VIEWPORT")).toBe(true);
  });

  test("does not fire on a functional spec", () => {
    // A real non-visual spec body: the failure direction that matters, since a
    // false positive here fires the advisory on ordinary work.
    expect(
      specDeclaresVisualJudgment(
        "## Summary\n\nThe poll cursor cannot advance past an unparsed update, so the " +
          "sweeper re-reads the same row forever. Fix the comparator and add a regression test."
      )
    ).toBe(false);
  });

  test("an empty spec is not visual", () => {
    expect(specDeclaresVisualJudgment("")).toBe(false);
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
    surfaces: [PEEK_HOST],
    trigger: "added-surface" as const,
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
      surfaces: [],
      trigger: "added-surface" as const,
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
    const warning = buildDesignPassWarning([PEEK_HOST], "added-surface");

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
    const warning = buildDesignPassWarning(many, "added-surface");

    expect(warning).toContain("... and 3 more");
    expect(warning).toContain("src/cockpit/web/components/S0.tsx");
    // A silent cap reads as "these are all of them" — the mt#4096 shape.
    expect(warning).not.toContain(`src/cockpit/web/components/S${MAX_REPORTED_SURFACES}.tsx`);
  });
});

describe("parsing git --name-status (PR #3189 R1)", () => {
  test("a rename below 100 yields the NEW path as modified", () => {
    // The defect: `R095\told\tnew` has THREE fields, so a two-field read takes
    // `old` — a path that no longer exists — and the real, changed file is never
    // classified at all.
    const { added, modified } = parseNameStatus(
      "R095\tsrc/cockpit/web/components/Old.tsx\tsrc/cockpit/web/components/New.tsx"
    );

    expect(modified).toEqual(["src/cockpit/web/components/New.tsx"]);
    expect(added).toEqual([]);
  });

  test("a PURE move (R100) is neither added nor modified", () => {
    // Relocating a component unchanged is not design work; counting it would fire
    // on every refactor that shuffles files.
    const { added, modified } = parseNameStatus("R100\ta/Old.tsx\ta/New.tsx");

    expect(added).toEqual([]);
    expect(modified).toEqual([]);
  });

  test("A and M still parse, and unknown statuses are ignored", () => {
    const { added, modified } = parseNameStatus(
      ["A\tsrc/a.tsx", "M\tsrc/b.tsx", "D\tsrc/gone.tsx", ""].join("\n")
    );

    expect(added).toEqual(["src/a.tsx"]);
    expect(modified).toEqual(["src/b.tsx"]);
  });
});
