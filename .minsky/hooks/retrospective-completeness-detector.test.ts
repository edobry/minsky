import { describe, expect, test } from "bun:test";
import {
  analyze,
  citedTaskIds,
  hasRetrospectiveShape,
  hasSection,
  OVERRIDE_ENV_VAR,
  parseTriageLevel,
  requiredSectionsFor,
  run,
  statedFamilyCount,
  taskIdsWithStatusRead,
} from "./retrospective-completeness-detector";
import type { TranscriptLine } from "./transcript";

/** A complete `Process failure` retrospective — the shape that must NOT fire. */
const COMPLETE_PROCESS_RETRO = `
## Retrospective: something went wrong

### Triage
Process failure — a required verification step was skipped.

### Incident
The thing broke.

### Agent error (cognitive)
Verification Error.

### Failure mode: enforcement gap
Nothing enforced the step.

### Root cause
One level deeper than the obvious.

### Recurrence check
No prior instance found.

### Fixes
1. **hook** [tier: pre-commit hook]: add the check.

### Verification
Yes, this would have caught it.
`;

/** The same retrospective with `### Verification` removed. */
const PROCESS_RETRO_MISSING_VERIFICATION = COMPLETE_PROCESS_RETRO.replace(
  /### Verification[\s\S]*$/,
  ""
);

const MINOR_COMPRESSED = `
## Retrospective: a small slip

### Triage
Minor correction — a one-off typo in a path, fixed inline.

**Correction noted**: wrong file path.
**Fix**: corrected the path.
**Memory saved**: no — not a new pattern.
`;

const REPEATED_MISSING_ESCALATION = `
## Retrospective: the same thing again

### Triage
Repeated failure — this is the fifth time.

### Incident
Same as before.

### Agent error (cognitive)
Assumption Error.

### Failure mode: enforcement gap
Prose does not enforce.

### Root cause
The check is advisory.

### Recurrence check
**Recurrence count**: 5

### Fixes
1. **detector** [tier: hook]: mechanize it.

### Verification
It would have caught it deterministically.
`;

/** mem#823's shape: a narrative memo with no skill structure at all. */
const NARRATIVE_MEMO = `
# Confabulated delegation boundary, and the retrospective it suppressed

## Part 1 — inventing a decision that does not exist

The agent halted claiming a principal decision. There was none.

**Family:** confabulated-strategic-frame (root 88d92439).

## Root cause

Low confidence converted into a governance claim.
`;

function toolUseLine(name: string, input: Record<string, unknown>): TranscriptLine {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  } as unknown as TranscriptLine;
}

describe("parseTriageLevel", () => {
  test("reads each declared level", () => {
    expect(parseTriageLevel(COMPLETE_PROCESS_RETRO)).toBe("process");
    expect(parseTriageLevel(MINOR_COMPRESSED)).toBe("minor");
    expect(parseTriageLevel(REPEATED_MISSING_ESCALATION)).toBe("repeated");
  });

  test("returns unknown when no Triage section was produced", () => {
    expect(parseTriageLevel(NARRATIVE_MEMO)).toBe("unknown");
  });

  test("prefers 'repeated' when a triage line mentions both", () => {
    const both = "### Triage\nRepeated failure — and also a process failure in shape.";
    expect(parseTriageLevel(both)).toBe("repeated");
  });
});

describe("hasSection", () => {
  test("matches a heading, not a prose mention of the same word", () => {
    expect(hasSection(COMPLETE_PROCESS_RETRO, "Verification")).toBe(true);
    expect(hasSection("I did some verification of the fix.", "Verification")).toBe(false);
  });

  test("matches the skill's `### Failure mode: <category>` heading form", () => {
    expect(hasSection(COMPLETE_PROCESS_RETRO, "Failure mode")).toBe(true);
  });
});

describe("statedFamilyCount", () => {
  test("reads an explicit recurrence count", () => {
    expect(statedFamilyCount(REPEATED_MISSING_ESCALATION)).toBe(5);
  });

  test("reads an R-number claim", () => {
    expect(statedFamilyCount("this incident is **R5** of the family")).toBe(5);
  });

  test("returns 0 when no count is stated", () => {
    expect(statedFamilyCount(MINOR_COMPRESSED)).toBe(0);
  });
});

describe("requiredSectionsFor", () => {
  test("Minor requires only Triage — the compressed format is legitimate", () => {
    expect(requiredSectionsFor("minor", 0)).toEqual(["Triage"]);
  });

  test("Process requires the full set but not Escalation", () => {
    const required = requiredSectionsFor("process", 0);
    expect(required).toContain("Verification");
    expect(required).not.toContain("Escalation");
  });

  test("Repeated additionally requires Escalation", () => {
    expect(requiredSectionsFor("repeated", 0)).toContain("Escalation");
  });

  test("a stated family count >= 3 forces Escalation even at Process triage", () => {
    expect(requiredSectionsFor("process", 3)).toContain("Escalation");
    expect(requiredSectionsFor("process", 2)).not.toContain("Escalation");
  });

  test("unknown triage is treated as the full set", () => {
    expect(requiredSectionsFor("unknown", 0)).toContain("Verification");
  });
});

describe("citedTaskIds / taskIdsWithStatusRead", () => {
  test("collects cited task ids", () => {
    expect(citedTaskIds("fixes are mt#2052 and mt#2755")).toEqual(["mt#2052", "mt#2755"]);
  });

  test("counts a status read only when a liveness tool named the id", () => {
    const lines = [
      toolUseLine("mcp__minsky__tasks_status_get", { taskId: "mt#2052" }),
      toolUseLine("mcp__minsky__tasks_search", { query: "mt#2755" }),
    ];
    const read = taskIdsWithStatusRead(lines);
    expect(read.has("mt#2052")).toBe(true);
    expect(read.has("mt#2755")).toBe(false);
  });
});

describe("analyze — AT1..AT5", () => {
  test("AT1: Process failure missing Verification is flagged", () => {
    const finding = analyze(PROCESS_RETRO_MISSING_VERIFICATION, []);
    expect(finding.triage).toBe("process");
    expect(finding.missingSections).toContain("Verification");
  });

  test("AT2: a correctly-compressed Minor correction is NOT flagged", () => {
    const finding = analyze(MINOR_COMPRESSED, []);
    expect(finding.triage).toBe("minor");
    expect(finding.missingSections).toEqual([]);
    expect(finding.unverifiedTaskIds).toEqual([]);
  });

  test("AT3: Repeated failure stating count 5 but omitting Escalation is flagged", () => {
    const finding = analyze(REPEATED_MISSING_ESCALATION, []);
    expect(finding.familyCount).toBe(5);
    expect(finding.missingSections).toEqual(["Escalation"]);
  });

  test("AT4: a cited fix-task with no in-turn status read is flagged", () => {
    const text = `${COMPLETE_PROCESS_RETRO}\nStructural-fix task: mt#2052.`;
    const finding = analyze(text, []);
    expect(finding.unverifiedTaskIds).toContain("mt#2052");
  });

  test("AT4: the same citation is NOT flagged once the status was read in-turn", () => {
    const text = `${COMPLETE_PROCESS_RETRO}\nStructural-fix task: mt#2052.`;
    const lines = [toolUseLine("mcp__minsky__tasks_status_get", { taskId: "mt#2052" })];
    const finding = analyze(text, lines);
    expect(finding.unverifiedTaskIds).toEqual([]);
  });

  test("AT5: the 2026-08-03 narrative-memo shape is flagged on the full set", () => {
    const finding = analyze(NARRATIVE_MEMO, []);
    expect(finding.triage).toBe("unknown");
    // The memo has a `## Root cause`, so that one is present; everything else
    // the skill requires at the full set is absent.
    expect(finding.missingSections).toContain("Triage");
    expect(finding.missingSections).toContain("Verification");
    expect(finding.missingSections).toContain("Recurrence check");
  });

  test("negative control: the COMPLETE retrospective produces no finding", () => {
    const finding = analyze(COMPLETE_PROCESS_RETRO, []);
    expect(finding.missingSections).toEqual([]);
    expect(finding.unverifiedTaskIds).toEqual([]);
  });
});

describe("run — AT6, AT7", () => {
  const input = {
    transcript_path: "/tmp/does-not-need-to-exist.jsonl",
    session_id: "test-session",
  } as unknown as Parameters<typeof run>[0];

  function ctxWith(lines: unknown): Parameters<typeof run>[1] {
    return { transcriptLines: lines } as unknown as Parameters<typeof run>[1];
  }

  function assistantTextLine(text: string): TranscriptLine {
    return {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    } as unknown as TranscriptLine;
  }

  test("AT6: runs off whatever turn window the dispatcher supplies", async () => {
    // The Stop-recorded anchor vs `resolveCompletedTurn` fallback is resolved
    // UPSTREAM, in the dispatcher, and reaches this guard only as
    // `ctx.transcriptLines`. What is testable here — and what AT6 actually
    // constrains for this module — is that the guard produces the same verdict
    // from a supplied window regardless of how that window was derived.
    const lines = [
      { type: "user", message: { role: "user", content: "go" } } as unknown as TranscriptLine,
      assistantTextLine(PROCESS_RETRO_MISSING_VERIFICATION),
    ];
    const outcome = await run(input, ctxWith(lines));
    expect(outcome).not.toBeNull();
    expect(outcome?.calibration?.["missing_sections"]).toContain("Verification");
    expect(outcome?.calibration?.["source"]).toBe("live");
    // Log-only: it must never spend the agent's attention while unmeasured.
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("AT6: a complete retrospective produces no record", async () => {
    const lines = [assistantTextLine(COMPLETE_PROCESS_RETRO)];
    expect(await run(input, ctxWith(lines))).toBeNull();
  });

  test("AT7: a scan that throws records a degraded marker, not a silent pass", async () => {
    // ADR-024's fail-to-degraded-never-silent-skip invariant. A throwing
    // iterator stands in for any structural surprise in the transcript.
    const explodingCtx = {
      get transcriptLines(): never {
        throw new Error("synthetic transcript failure");
      },
    } as unknown as Parameters<typeof run>[1];
    const outcome = await run(input, explodingCtx);
    expect(outcome).not.toBeNull();
    expect(outcome?.calibration?.["degraded"]).toContain("synthetic transcript failure");
    // A degraded scan must be distinguishable from a clean turn — the whole
    // point of the invariant is that "could not check" never reads as "fine".
    expect(outcome?.calibration?.["missing_sections"]).toBeUndefined();
  });

  test("AT7: an empty transcript is a no-op, not a degraded record", async () => {
    expect(await run(input, ctxWith([]))).toBeNull();
  });

  test("the override env var short-circuits to an audit line", async () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const lines = [assistantTextLine(PROCESS_RETRO_MISSING_VERIFICATION)];
      const outcome = await run(input, ctxWith(lines));
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
      expect(outcome?.calibration).toBeUndefined();
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});

describe("hasRetrospectiveShape", () => {
  test("fires on retrospective-shaped headings", () => {
    expect(hasRetrospectiveShape(COMPLETE_PROCESS_RETRO)).toBe(true);
    expect(hasRetrospectiveShape(NARRATIVE_MEMO)).toBe(true);
  });

  test("does not fire on a bare prose mention", () => {
    expect(hasRetrospectiveShape("I should run a retrospective on this later.")).toBe(false);
  });
});
