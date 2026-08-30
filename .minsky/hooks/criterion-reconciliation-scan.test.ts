/**
 * mt#4213 — adapter tests. The matcher's own semantics are covered in
 * `packages/domain/src/detectors/criterion-reconciliation.test.ts`; this file covers
 * what the adapter adds: tool-field resolution across all three spec-write tools, the
 * REAL elider composition, the evaluation record, and the override.
 */

import { describe, expect, test } from "bun:test";
import {
  buildInjectionReminder,
  evaluateCall,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  renderWorstCase,
  run,
  SPEC_TEXT_FIELD_BY_TOOL,
} from "./criterion-reconciliation-scan";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";

/** A write that fires: asserts AT3 unmet, names it, carries no criteria section. */
const FIRING_WRITE = [
  "## Outcome",
  "",
  "AT3 as written cannot be satisfied by the fix SC1 describes; the operand",
  "short-circuits before any flag table is consulted.",
].join("\n");

const ctx = {} as DispatchContext;

/** Hoisted: the tool name recurs across fixtures and is not a magic string per use. */
const PATCH = "tasks_spec_patch";
const PATCH_TOOL = `mcp__minsky__${PATCH}`;

function toolInput(tool: string, body: string): ToolHookInput {
  const key = SPEC_TEXT_FIELD_BY_TOOL[tool];
  return {
    tool_name: `mcp__minsky__${tool}`,
    tool_input: { taskId: "mt#9999", [key ?? "content"]: body },
    session_id: "test-session",
    cwd: "/tmp/does-not-matter",
  } as unknown as ToolHookInput;
}

describe("tool-field resolution", () => {
  test("covers all three spec-write tools SC1 names", () => {
    expect(Object.keys(SPEC_TEXT_FIELD_BY_TOOL).sort()).toEqual([
      "tasks_edit",
      "tasks_spec_patch",
      "tasks_spec_search_replace",
    ]);
  });

  for (const tool of [PATCH, "tasks_edit", "tasks_spec_search_replace"]) {
    test(`reads the authored body from ${tool}`, () => {
      const input = toolInput(tool, FIRING_WRITE);
      const evaluated = evaluateCall(input.tool_name, input.tool_input);

      expect(evaluated).not.toBeNull();
      expect(evaluated?.result.findings.map((f) => f.criterionId)).toContain("AT3");
      expect(evaluated?.evaluation["fired"]).toBe(true);
    });
  }

  test("tasks_create is deliberately NOT scanned", () => {
    expect(SPEC_TEXT_FIELD_BY_TOOL["tasks_create"]).toBeUndefined();
    const evaluated = evaluateCall("mcp__minsky__tasks_create", { spec: FIRING_WRITE });
    expect(evaluated).toBeNull();
  });

  test("a call carrying no spec body yields no record at all", () => {
    expect(evaluateCall(PATCH_TOOL, { taskId: "mt#1" })).toBeNull();
  });

  test("a named-but-unreadable specFile is recorded as a MISS, not as silence", () => {
    const evaluated = evaluateCall(
      "mcp__minsky__tasks_edit",
      { taskId: "mt#1", specFile: "/nope/missing.md" },
      () => null
    );

    expect(evaluated).not.toBeNull();
    expect(evaluated?.evaluation["specFileUnreadable"]).toBe(true);
    expect(evaluated?.evaluation["fired"]).toBe(false);
  });
});

describe("the real elider is composed, not stubbed", () => {
  test("an assertion inside a fenced block does not fire", () => {
    const write = [
      "## Context",
      "",
      "The reviewer wording this guard matches is:",
      "",
      "```",
      "AT3 cannot be satisfied by the current fix",
      "```",
    ].join("\n");

    const evaluated = evaluateCall(PATCH_TOOL, { content: write });
    expect(evaluated?.result.findings).toEqual([]);
  });

  test("an assertion inside a prose-quoted span does not fire", () => {
    const write = [
      "## Context",
      "",
      'The bot posted "AT3 cannot be satisfied as written" and we amended in place.',
    ].join("\n");

    const evaluated = evaluateCall(PATCH_TOOL, { content: write });
    expect(evaluated?.result.findings).toEqual([]);
  });
});

describe("evaluation record", () => {
  test("records a non-firing evaluation, so the stream has a miss denominator", () => {
    const evaluated = evaluateCall(PATCH_TOOL, {
      content: "## Context\n\nNothing asserted here.",
    });

    expect(evaluated?.evaluation["fired"]).toBe(false);
    expect(evaluated?.evaluation["findingCount"]).toBe(0);
    expect(typeof evaluated?.evaluation["specChars"]).toBe("number");
  });

  test("records amendedCount even when nothing fires — the compliant shape is data", () => {
    const write = [
      "## Success Criteria",
      "",
      "- [ ] one",
      "- [ ] two",
      "",
      "## Outcome",
      "",
      "SC2 cannot be satisfied as first written; amended above.",
    ].join("\n");

    const evaluated = evaluateCall(PATCH_TOOL, { content: write });
    expect(evaluated?.result.findings).toEqual([]);
    expect(evaluated?.evaluation["amendedCount"]).toBe(2);
  });
});

describe("run()", () => {
  test("returns a calibration record on a fire and does not inject while log-only", () => {
    const outcome = run(toolInput(PATCH, FIRING_WRITE), ctx);

    expect(outcome).not.toBeNull();
    expect(outcome?.calibration).toBeDefined();
    expect(INJECTION_ENABLED).toBe(false);
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("returns null when nothing fires", () => {
    const outcome = run(toolInput(PATCH, "## Context\n\nplain prose"), ctx);
    expect(outcome).toBeNull();
  });

  test("the override short-circuits to an audit line and never a calibration record", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(toolInput(PATCH, FIRING_WRITE), ctx);
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
      expect(outcome?.calibration).toBeUndefined();
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});

describe("injection text", () => {
  test("names the criteria it fired on", () => {
    const text = buildInjectionReminder({
      amended: [],
      findings: [{ criterionId: "AT3", assertion: "cannot be satisfied", excerpt: "x" }],
    });
    expect(text).toContain("AT3");
  });

  test("renderWorstCase is bounded enough to declare an attention cost", () => {
    expect(renderWorstCase().length).toBeLessThan(2000);
  });
});
