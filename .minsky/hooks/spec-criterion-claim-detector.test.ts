/**
 * Spec-criterion-claim detector (adapter) tests — mt#4153.
 *
 * The matcher's class logic is tested in
 * `packages/domain/src/detectors/spec-criterion-claim.test.ts` with a passthrough
 * elider. THIS file is where the real `elideMarkdownNonProse` is wired, so it owns
 * SC8: the assertion that elision actually fires. Without that, the elision is
 * unfalsifiable from outside — the shape ADR-024 §Negative/risks calls the
 * load-bearing, harder part.
 *
 * The ask resolver is injected throughout, so nothing here needs a database and no
 * collaborator is patched in place (ADR-036).
 */

import { describe, test, expect } from "bun:test";
import {
  buildAuthorizingSource,
  buildInjectionReminder,
  evaluateCall,
  readSpecText,
  readTaskId,
  renderWorstCase,
  INJECTION_ENABLED,
} from "./spec-criterion-claim-detector";
import type { AuthorizingSource } from "../../packages/domain/src/detectors/spec-criterion-claim";

const CREATE_TOOL = "mcp__minsky__tasks_create";
const PATCH_TOOL = "mcp__minsky__tasks_spec_patch";
const EDIT_TOOL = "mcp__minsky__tasks_edit";
const SC_SECTION = "Success Criteria";
const SC_HEADING = `## ${SC_SECTION}`;
/** A criterion that asserts nothing about corpus state — the quiet control. */
const PLAIN_CRITERION = "- [ ] The parser rejects a trailing comma.";

const noSource = async (): Promise<AuthorizingSource | null> => null;

const R2_ASK: AuthorizingSource = {
  askId: "ask#8467",
  chosen: "One decision record answering the seven open questions, then implementation subtasks",
  description:
    "Write a single ADR covering all seven questions, then file the subtasks it implies.",
};

describe("SC8 — the elision actually fires (real elideMarkdownNonProse)", () => {
  test("a trigger whose ONLY occurrence is inside a fenced block produces no finding", async () => {
    // This is the case that would make the detector fire hardest on the very
    // specs that document it: an incident write-up quotes the offending criterion
    // verbatim in a fence.
    const spec = [
      SC_HEADING,
      "",
      PLAIN_CRITERION,
      "",
      "```",
      "- [ ] `MINSKY_ACK_FOO` remains documented in CLAUDE.md",
      "```",
    ].join("\n");

    const evaluated = await evaluateCall(CREATE_TOOL, { spec }, noSource);
    expect(evaluated?.result.matched).toBe(false);
  });

  test("a trigger whose ONLY occurrence is inside a blockquote produces no finding", async () => {
    const spec = [
      SC_HEADING,
      "",
      PLAIN_CRITERION,
      "  > quoting mem#790: the override remains documented in CLAUDE.md",
    ].join("\n");

    const evaluated = await evaluateCall(CREATE_TOOL, { spec }, noSource);
    expect(evaluated?.result.matched).toBe(false);
  });

  test("the SAME text unfenced DOES produce a finding", async () => {
    // The other half of SC8: without this, "no finding" is indistinguishable from
    // a detector that never looks.
    const spec = [SC_HEADING, "", "- [ ] `MINSKY_ACK_FOO` remains documented in CLAUDE.md"].join(
      "\n"
    );

    const evaluated = await evaluateCall(CREATE_TOOL, { spec }, noSource);
    expect(evaluated?.result.matched).toBe(true);
    expect(evaluated?.result.findings[0]?.klass).toBe("A");
  });

  test("a trigger inside a PROSE-QUOTED span produces no finding", async () => {
    // SC7's fourth context, and the half `elideMarkdownNonProse` does not cover —
    // hence the composed SPEC_ELIDER. Verbatim shape of a real corpus false
    // positive (mt#4199): the trigger sits in a quoted sample message, so it is
    // example text rather than an assertion about the repo.
    const spec = [
      SC_HEADING,
      "",
      PLAIN_CRITERION,
      '- [ ] A closing message saying "still with you: ask#N" produces a fire record in `CLAUDE.md`.',
    ].join("\n");

    const evaluated = await evaluateCall(CREATE_TOOL, { spec }, noSource);
    expect(evaluated?.result.matched).toBe(false);
  });

  test("an apostrophe does not blank the rest of the line", async () => {
    // Why single quotes are excluded from the quoted-span pass: an apostrophe opens
    // a span that never closes, and blanking to end-of-line would silently swallow
    // a real assertion sitting after it.
    const spec = [
      SC_HEADING,
      "",
      "- [ ] The agent's override `MINSKY_ACK_FOO` remains documented in CLAUDE.md",
    ].join("\n");

    const evaluated = await evaluateCall(CREATE_TOOL, { spec }, noSource);
    expect(evaluated?.result.matched).toBe(true);
  });
});

describe("spec-text and task-id extraction per tool (mt#4153)", () => {
  test("reads the spec body under each tool's own key", () => {
    expect(readSpecText(CREATE_TOOL, { spec: "body" }).text).toBe("body");
    expect(readSpecText(PATCH_TOOL, { content: "body" }).text).toBe("body");
    expect(readSpecText(EDIT_TOOL, { specContent: "body" }).text).toBe("body");
  });

  test("an unrelated tool, or a call with no spec body, yields null", () => {
    expect(readSpecText("Bash", { command: "ls" }).text).toBeNull();
    expect(readSpecText(CREATE_TOOL, {}).text).toBeNull();
    expect(readSpecText(CREATE_TOOL, { spec: "   " }).text).toBeNull();
    expect(readSpecText(undefined, undefined).text).toBeNull();
  });

  // --- `specFile` on tasks_edit (PR #3063 R1, BLOCKING) ------------------------
  //
  // `tasks_edit` takes the new spec EITHER inline as `specContent` OR as a path in
  // `specFile`; only the inline form was read, so an edit using the path was scanned
  // as if it carried no spec. The reader is injected here rather than writing a temp
  // file, per `testing-standards.mdc §Testable Design`.

  test("a tasks_edit specFile path is read as the spec body", () => {
    const read = readSpecText(EDIT_TOOL, { specFile: "/tmp/spec.md" }, (p) =>
      p === "/tmp/spec.md" ? "## Success Criteria\n\n- [ ] one" : null
    );

    expect(read.text).toBe("## Success Criteria\n\n- [ ] one");
    expect(read.specFileUnreadable).toBe(false);
  });

  test("an inline specContent wins over a specFile, without reading the file", () => {
    let reads = 0;
    const read = readSpecText(
      EDIT_TOOL,
      { specContent: "inline", specFile: "/tmp/spec.md" },
      () => {
        reads++;
        return "from disk";
      }
    );

    expect(read.text).toBe("inline");
    expect(reads).toBe(0);
  });

  test("an unreadable specFile reports a MISS rather than 'no spec'", () => {
    // The distinction the evaluation stream needs: a hole it cannot see is a hole
    // nothing will measure.
    const read = readSpecText(EDIT_TOOL, { specFile: "/tmp/gone.md" }, () => null);

    expect(read.text).toBeNull();
    expect(read.specFileUnreadable).toBe(true);
  });

  test("tasks_create has no specFile parameter, so a stray one is not read", () => {
    // Verified against the tool's own schema: `tasks_create` takes the body inline
    // only. Reading a key the tool does not accept would invent coverage.
    const read = readSpecText(CREATE_TOOL, { specFile: "/tmp/spec.md" }, () => "from disk");

    expect(read.text).toBeNull();
    expect(read.specFileUnreadable).toBe(false);
  });

  test("tasks_edit's own `spec` is a BOOLEAN flag, not a spec body", () => {
    // PR #3063 R1 read `tasks_edit`'s `spec` as a missing body key. Its schema types
    // it `boolean` (default false) — `tasks_create`'s `spec` is the string one. A
    // boolean must not be coerced into scannable text.
    const read = readSpecText(EDIT_TOOL, { spec: true }, () => null);

    expect(read.text).toBeNull();
    expect(read.specFileUnreadable).toBe(false);
  });

  test("an evaluation record is still written for an unreadable specFile", async () => {
    const evaluated = await evaluateCall(
      EDIT_TOOL,
      { taskId: "mt#4153", specFile: "/tmp/gone.md" },
      noSource,
      () => null
    );

    expect(evaluated).not.toBeNull();
    expect(evaluated?.evaluation.specFileUnreadable).toBe(true);
    expect(evaluated?.evaluation.fired).toBe(false);
    expect(evaluated?.result.matched).toBe(false);
  });

  test("the task id is present on an edit and absent on a create", () => {
    expect(readTaskId({ taskId: "mt#4153" })).toBe("mt#4153");
    expect(readTaskId({ title: "new task" })).toBeNull();
  });

  test("a call carrying no spec body is not evaluated at all", async () => {
    expect(await evaluateCall("Bash", { command: "ls" }, noSource)).toBeNull();
  });
});

describe("Class B reachability across surfaces (mt#4153)", () => {
  const invented = [SC_HEADING, "", "- [ ] Subtasks are filed once the ADR is accepted."].join(
    "\n"
  );

  test("on a create, Class B cannot fire — no task id means no linked ask", async () => {
    // Not a gap: SC2's own rule. At create the task does not exist, so no ask can
    // point at it, and guessing is worse than silence.
    let resolverCalled = false;
    const resolver = async (): Promise<AuthorizingSource | null> => {
      resolverCalled = true;
      return R2_ASK;
    };

    const evaluated = await evaluateCall(CREATE_TOOL, { spec: invented }, resolver);

    expect(evaluated?.result.matched).toBe(false);
    expect(evaluated?.result.authorizingSourceAvailable).toBe(false);
    // The lookup is not even attempted — no id to look up.
    expect(resolverCalled).toBe(false);
  });

  test("on an edit with a linked ask, Class B fires (the R2 shape)", async () => {
    const evaluated = await evaluateCall(
      PATCH_TOOL,
      { taskId: "mt#2430", content: invented },
      async () => R2_ASK
    );

    expect(evaluated?.result.matched).toBe(true);
    expect(evaluated?.result.findings[0]?.klass).toBe("B");
    expect(evaluated?.result.findings[0]?.askId).toBe("ask#8467");
  });

  test("on an edit whose lookup returns null, Class B stays silent", async () => {
    const evaluated = await evaluateCall(
      PATCH_TOOL,
      { taskId: "mt#2430", content: invented },
      noSource
    );
    expect(evaluated?.result.matched).toBe(false);
    expect(evaluated?.result.authorizingSourceAvailable).toBe(false);
  });
});

describe("authorizing-source assembly (mt#4153)", () => {
  test("joins the chosen option to ITS description", () => {
    // The real constraint routinely lives in the description, so the join is the
    // part worth pinning: reading the label alone would fire on authorized work.
    const source = buildAuthorizingSource("ask#8467", { payload: { chosen: "Option B" } }, [
      { label: "Option A", description: "not this one" },
      { label: "Option B", description: "gated on the migration landing" },
    ]);
    expect(source?.askId).toBe("ask#8467");
    expect(source?.chosen).toBe("Option B");
    expect(source?.description).toBe("gated on the migration landing");
  });

  test("matches an option by `value` as well as `label`", () => {
    const source = buildAuthorizingSource("ask#1", { payload: { chosen: "b" } }, [
      { label: "B", value: "b", description: "by value" },
    ]);
    expect(source?.description).toBe("by value");
  });

  test("an unanswered ask yields no source", () => {
    expect(buildAuthorizingSource("ask#1", null, [])).toBeNull();
    expect(buildAuthorizingSource("ask#1", { payload: {} }, [])).toBeNull();
  });

  test("a chosen option with no matching entry still yields the chosen text", () => {
    const source = buildAuthorizingSource("ask#1", { payload: { chosen: "Gone" } }, []);
    expect(source?.chosen).toBe("Gone");
    expect(source?.description).toBe("");
  });
});

describe("evaluation stream (SC5) and calibration posture (SC4)", () => {
  test("a non-firing call still produces an evaluation record — the miss denominator", async () => {
    const spec = [SC_HEADING, "", PLAIN_CRITERION].join("\n");
    const evaluated = await evaluateCall(CREATE_TOOL, { spec }, noSource);

    expect(evaluated?.result.matched).toBe(false);
    expect(evaluated?.evaluation["fired"]).toBe(false);
    expect(evaluated?.evaluation["criteriaExamined"]).toBe(1);
    expect(evaluated?.evaluation["tool"]).toBe(CREATE_TOOL);
    expect(evaluated?.evaluation["taskIdPresent"]).toBe(false);
  });

  test("a firing call records per-class counts", async () => {
    const spec = [
      SC_HEADING,
      "",
      "- [ ] `FOO` remains documented.",
      "- [ ] Subtasks are filed once the ADR is accepted.",
    ].join("\n");
    const evaluated = await evaluateCall(
      PATCH_TOOL,
      { taskId: "mt#2430", content: spec },
      async () => R2_ASK
    );

    expect(evaluated?.evaluation["fired"]).toBe(true);
    expect(evaluated?.evaluation["classACount"]).toBe(1);
    expect(evaluated?.evaluation["classBCount"]).toBe(1);
    expect(evaluated?.evaluation["authorizingSourceAvailable"]).toBe(true);
  });

  test("injection is OFF during calibration", () => {
    // The flip is a separate, evidence-gated decision after a review pass over the
    // evaluation stream — not a judgement made here.
    expect(INJECTION_ENABLED).toBe(false);
  });
});

describe("feedback shape (guard-feedback-authoring.mdc)", () => {
  test("each class gets its OWN directive", () => {
    // A shared directive would tell a Class A author to go read an ask, which is
    // not the remedy for an unverified corpus claim (mt#3767's lesson).
    const classAOnly = buildInjectionReminder({
      matched: true,
      criteriaExamined: 1,
      authorizingSourceAvailable: false,
      findings: [{ section: SC_SECTION, criterion: "c", klass: "A", phrase: "remains" }],
    });
    expect(classAOnly).toContain("Class A");
    expect(classAOnly).not.toContain("Class B");

    const classBOnly = buildInjectionReminder({
      matched: true,
      criteriaExamined: 1,
      authorizingSourceAvailable: true,
      findings: [
        {
          section: SC_SECTION,
          criterion: "c",
          klass: "B",
          phrase: "once the ADR is accepted",
          askId: "ask#8467",
        },
      ],
    });
    expect(classBOnly).toContain("Class B");
    expect(classBOnly).toContain("ask#8467");
    expect(classBOnly).not.toContain("Class A asserts");
  });

  test("the reminder quotes the matched phrase, so a false positive is recognizable", () => {
    const text = buildInjectionReminder({
      matched: true,
      criteriaExamined: 1,
      authorizingSourceAvailable: false,
      findings: [
        {
          section: SC_SECTION,
          criterion: "the criterion text",
          klass: "A",
          phrase: "already",
        },
      ],
    });
    expect(text).toContain('"already"');
    expect(text).toContain("the criterion text");
  });

  test("the reminder carries a legitimate-halt branch", () => {
    const text = buildInjectionReminder({
      matched: true,
      criteriaExamined: 1,
      authorizingSourceAvailable: false,
      findings: [{ section: SC_SECTION, criterion: "c", klass: "A", phrase: "remains" }],
    });
    expect(text.toLowerCase()).toContain("keep it");
  });

  test("renderWorstCase saturates both class branches at once", () => {
    // mt#4002: a guard that gates injection off renders nothing live, so its
    // declared ceiling is measured against this probe or against nothing.
    const text = renderWorstCase();
    expect(text).toContain("Class A");
    expect(text).toContain("Class B");
    expect(text.length).toBeGreaterThan(500);
  });
});
