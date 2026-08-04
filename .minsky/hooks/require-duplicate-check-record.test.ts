/**
 * Tests for the tasks_create duplicate-check-record gate (mt#3673).
 */

import { describe, it, expect } from "bun:test";
// The SC3 drift test asserts the SHIPPED compiled skill's text against what this guard
// accepts. Injecting a mock fs would assert nothing about the real artifact, which is the
// only thing that can actually drift — so the real read IS the test.
// eslint-disable-next-line custom/no-real-fs-in-tests -- see above
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasDuplicateCheckRecord,
  buildDenialReason,
  run,
  NO_CANDIDATES_LINE,
  OVERRIDE_ENV_VAR,
} from "./require-duplicate-check-record";
import type { ToolHookInput } from "./types";
import type { DispatchContext } from "./registry";

const CTX = {} as DispatchContext;

function createInput(spec?: string): ToolHookInput {
  return {
    tool_name: "mcp__minsky__tasks_create",
    tool_input: spec === undefined ? { title: "t" } : { title: "t", spec },
  } as ToolHookInput;
}

describe("hasDuplicateCheckRecord", () => {
  it("accepts the literal no-candidates line Step 1a prescribes", () => {
    expect(hasDuplicateCheckRecord(`## Context\n\n${NO_CANDIDATES_LINE}\n`)).toBe(true);
  });

  it("accepts a named-candidates record with a reconciliation", () => {
    const spec =
      "## Context\n\nDuplicate check: mt#1234 covers the same surface; " +
      "confirm-orthogonal because it targets the CLI and this targets the hook.\n";
    expect(hasDuplicateCheckRecord(spec)).toBe(true);
  });

  it("tolerates markdown decoration specs are actually written with", () => {
    // Hand-authored specs use bullets and bold; rejecting those would make the
    // gate fire on records that ARE present, which is the false-positive class
    // this guard is designed not to have.
    expect(hasDuplicateCheckRecord("- **Duplicate check:** none found\n")).toBe(true);
    expect(hasDuplicateCheckRecord("* Duplicate check : mt#1 subsumed\n")).toBe(true);
    expect(hasDuplicateCheckRecord("  Duplicate check: searched twice\n")).toBe(true);
  });

  it("is case-insensitive on the label", () => {
    expect(hasDuplicateCheckRecord("duplicate check: no candidates found.\n")).toBe(true);
  });

  it("rejects a spec with no record at all", () => {
    expect(hasDuplicateCheckRecord("## Summary\n\nSomething useful.\n")).toBe(false);
  });

  it("rejects an absent, empty, or whitespace-only spec", () => {
    expect(hasDuplicateCheckRecord(undefined)).toBe(false);
    expect(hasDuplicateCheckRecord(null)).toBe(false);
    expect(hasDuplicateCheckRecord("")).toBe(false);
    expect(hasDuplicateCheckRecord("   \n  ")).toBe(false);
  });

  it("does not accept the phrase buried mid-sentence", () => {
    // The record is a labelled line, not a passing mention. A spec that merely
    // discusses duplicate checking has not performed one.
    expect(hasDuplicateCheckRecord("We should add a duplicate check: it would help.\n")).toBe(
      false
    );
  });
});

describe("run — the gate decision", () => {
  it("DENIES a create whose spec carries no record", () => {
    const outcome = run(createInput("## Summary\n\nNo record here.\n"), CTX);
    expect(outcome?.deny).toBeDefined();
    expect(outcome?.deny?.reason).toContain(NO_CANDIDATES_LINE);
  });

  it("DENIES a title-only create (no spec at all)", () => {
    // The drive-by shape: a follow-up filed mid-session with no spec. Nothing
    // could have recorded a search, so nothing did.
    expect(run(createInput(), CTX)?.deny).toBeDefined();
  });

  it("ALLOWS a create carrying the no-candidates line", () => {
    expect(run(createInput(`## Context\n\n${NO_CANDIDATES_LINE}\n`), CTX)).toBeNull();
  });

  it("ALLOWS a create carrying a named-candidates record", () => {
    const spec = "## Context\n\nDuplicate check: mt#99 — confirm-orthogonal, different surface.\n";
    expect(run(createInput(spec), CTX)).toBeNull();
  });

  it("allows and audit-logs when the override is set", () => {
    const prev = process.env[OVERRIDE_ENV_VAR];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(createInput("no record"), CTX);
      expect(outcome?.deny).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      if (prev === undefined) delete process.env[OVERRIDE_ENV_VAR];
      else process.env[OVERRIDE_ENV_VAR] = prev;
    }
  });
});

describe("buildDenialReason", () => {
  it("names both accepted forms and the override", () => {
    const reason = buildDenialReason();
    expect(reason).toContain(NO_CANDIDATES_LINE);
    expect(reason).toContain("tasks_search");
    expect(reason).toContain(OVERRIDE_ENV_VAR);
  });

  it("fits inside the attentionCost ceiling declared in the registry", () => {
    // PR #2612 R1 questioned whether the declared 900-char bound covered the
    // real message. It does — but the registry comment had asserted an
    // ESTIMATED "~780" that was never measured, which is what made the bound
    // unauditable. This pins the actual number so the ceiling and the message
    // cannot drift apart silently: the body is wholly static, so this length is
    // exact, not a sample.
    const len = buildDenialReason().length;
    expect(len).toBe(644);
    expect(len).toBeLessThan(900);
  });

  it("warns against trusting the similarity scores", () => {
    // mem#819's measured finding: at these distances the scores rank a true
    // duplicate below unrelated tasks. A denial that sent the agent to the
    // scores would reproduce the failure it is trying to prevent.
    expect(buildDenialReason()).toContain("TITLES");
  });
});

describe("skill-text agreement (mt#3673 SC3)", () => {
  it("the compiled /create-task skill tells agents to write what this guard accepts", () => {
    // The guard is TypeScript and the skill is prose, so they cannot share a
    // constant by import. This test is the only thing keeping them aligned: if
    // someone rewords Step 1a's prescribed line, the gate would silently stop
    // matching what agents are told to write.

    // compiled skill; the whole point is asserting the SHIPPED artifact's text, so a
    // fixture would assert nothing about the drift this test exists to catch
    const skillPath = join(
      import.meta.dir,
      "..",
      "..",
      ".claude",
      "skills",
      "create-task",
      "SKILL.md"
    );
    // eslint-disable-next-line custom/no-real-fs-in-tests -- the real artifact is the subject
    const skill = readFileSync(skillPath, "utf8");
    expect(skill).toContain(NO_CANDIDATES_LINE);
    // And the guard must actually accept the form the skill prescribes.
    expect(hasDuplicateCheckRecord(`## Context\n\n${NO_CANDIDATES_LINE}`)).toBe(true);
  });
});
