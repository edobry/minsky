/* eslint-disable custom/no-real-fs-in-tests -- the hook reads real transcript files via fs.readFileSync and E2E tests must write real transcript JSONL files so Bun.spawn can read them */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPreNarrationRecord,
  detectPreNarration,
  detectPreNarrationWithSuppression,
  elideMarkdownContexts,
  extractMatchContext,
  extractWindowToolUseNames,
  MATCH_CONTEXT_MAX_CHARS,
  OVERRIDE_ENV_VAR,
  OUTCOME_CATEGORIES,
  SUPPRESSION_SAME_TURN_TOOL_CALL,
  SUPPRESSION_WINDOW_TOOL_CALL,
  TRAILING_WINDOW_TURNS,
  run,
} from "./pre-narration-detector";
import {
  extractDistinctPhrases,
  parseCalibrationRecord,
} from "../../src/domain/calibration/calibration-sweep";
import { parseTranscript, extractLastAssistantTurn } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

const CREATED_PR_CLAIM = "Created PR #4242.";
const APPROVED_CLAIM = "The review came back: APPROVED, no findings.";
const PR_CREATE_TOOL = "mcp__minsky__session_pr_create";

// ---------------------------------------------------------------------------
// Transcript JSONL helpers
// ---------------------------------------------------------------------------

type TranscriptLine = {
  type?: string;
  message?: { role?: string; content?: unknown };
  name?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
};

function makeUserLine(): TranscriptLine {
  return { type: "user", message: { role: "user", content: "test user message" } };
}

function makeAssistantLine(text: string): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function makeToolUseLine(toolName: string): TranscriptLine {
  return { type: "tool_use", name: toolName, input: {} };
}

function makeAssistantToolUseLine(toolName: string): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: toolName, input: {} }] },
  };
}

function makeToolResultLine(): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  };
}

function buildTranscriptJSONL(lines: TranscriptLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

function makeHookInput(transcriptPath: string): ClaudeHookInput {
  return {
    session_id: "test-session-pre-narration",
    transcript_path: transcriptPath,
    cwd: "/tmp",
    hook_event_name: "UserPromptSubmit",
  } as ClaudeHookInput;
}

async function invokeHook(
  input: ClaudeHookInput,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const hookPath = new URL("pre-narration-detector.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", "run", hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Pure detection: detectPreNarration
// ---------------------------------------------------------------------------

describe("detectPreNarration — claim without matching tool", () => {
  test("'Created PR #123' with NO tool in the turn → flagged (pr-created)", () => {
    const turn = [makeAssistantLine("Done. Created PR #123 and it is up.")];
    const matches = detectPreNarration(turn);
    expect(matches.some((m) => m.category === "pr-created")).toBe(true);
  });

  test("'Created PR #123' WITH session_pr_create in the turn → not flagged", () => {
    const turn = [makeAssistantLine("Created PR #123."), makeToolUseLine(PR_CREATE_TOOL)];
    const matches = detectPreNarration(turn);
    expect(matches.some((m) => m.category === "pr-created")).toBe(false);
  });

  test("intent language ('I'll create the PR next') → not flagged", () => {
    const turn = [makeAssistantLine("Next, I'll create the PR and then drive review.")];
    const matches = detectPreNarration(turn);
    expect(matches.length).toBe(0);
  });

  test("'tests pass' with no Bash/exec → flagged (build-test)", () => {
    const turn = [makeAssistantLine("All good — tests pass and the build is green.")];
    const matches = detectPreNarration(turn);
    expect(matches.some((m) => m.category === "build-test")).toBe(true);
  });

  test("'tests pass' WITH session_exec → not flagged", () => {
    const turn = [makeAssistantLine("tests pass."), makeToolUseLine("mcp__minsky__session_exec")];
    const matches = detectPreNarration(turn);
    expect(matches.some((m) => m.category === "build-test")).toBe(false);
  });

  test("'merged the PR' with no merge tool → flagged (merged)", () => {
    const turn = [makeAssistantLine("Successfully merged the PR.")];
    const matches = detectPreNarration(turn);
    expect(matches.some((m) => m.category === "merged")).toBe(true);
  });

  test("'review came back APPROVED' with no review tool → flagged (review-approved)", () => {
    const turn = [makeAssistantLine(APPROVED_CLAIM)];
    const matches = detectPreNarration(turn);
    expect(matches.some((m) => m.category === "review-approved")).toBe(true);
  });

  test("claim inside a code fence is elided → not flagged", () => {
    const turn = [
      makeAssistantLine("Here is example output:\n\n```\nCreated PR #999\ntests pass\n```\n"),
    ];
    const matches = detectPreNarration(turn);
    expect(matches.length).toBe(0);
  });

  test("empty turn → no matches", () => {
    expect(detectPreNarration([]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-turn suppression — trailing window (mt#2671)
// ---------------------------------------------------------------------------

describe("cross-turn suppression — trailing window (mt#2671)", () => {
  const WAIT_TOOL = "mcp__minsky__session_pr_wait-for-review";

  /**
   * Transcript: verdict fetched at turn N, back-reference two turns later.
   * The trailing user line models the CURRENT prompt (extractLastAssistantTurn
   * extracts the segment between the last two real prompts, so the claim turn
   * must sit before a final prompt — the real hook-invocation shape).
   */
  function transcriptWithPriorFetch(claimText: string, fetchTool: string) {
    return [
      makeUserLine(),
      makeAssistantToolUseLine(fetchTool),
      makeToolResultLine(),
      makeAssistantLine("Review result received."),
      makeUserLine(),
      makeAssistantLine("Pushed the fix."),
      makeUserLine(),
      makeAssistantLine(claimText),
      makeUserLine(),
    ];
  }

  test("AT1/AT3: CHANGES_REQUESTED back-reference with wait-for-review 2 turns back → suppressed", () => {
    const lines = transcriptWithPriorFetch(
      "As established, the bot returned CHANGES_REQUESTED on the first round.",
      WAIT_TOOL
    );
    const turn = extractLastAssistantTurn(lines as never);
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    const matches = detectPreNarration(turn, windowTools);
    expect(matches.some((m) => m.category === "review-approved")).toBe(false);
  });

  test("AT1 negative / SC2: same prose with NO fetch anywhere in the window → still fires", () => {
    const lines = [
      makeUserLine(),
      makeAssistantLine("Investigating."),
      makeUserLine(),
      makeAssistantLine(APPROVED_CLAIM),
      makeUserLine(),
    ];
    const turn = extractLastAssistantTurn(lines as never);
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    const matches = detectPreNarration(turn, windowTools);
    expect(matches.some((m) => m.category === "review-approved")).toBe(true);
  });

  test("AT2: 'PR was created' with session_pr_create in a prior turn → suppressed", () => {
    const lines = transcriptWithPriorFetch(
      "Recall the PR was created earlier; now driving convergence.",
      PR_CREATE_TOOL
    );
    const turn = extractLastAssistantTurn(lines as never);
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    const matches = detectPreNarration(turn, windowTools);
    expect(matches.some((m) => m.category === "pr-created")).toBe(false);
  });

  test("a backing tool call OLDER than the window does not suppress", () => {
    const lines: ReturnType<typeof makeUserLine>[] = [
      makeUserLine(),
      makeAssistantToolUseLine(WAIT_TOOL),
      makeAssistantLine("Fetched long ago."),
    ];
    // Push TRAILING_WINDOW_TURNS filler turns so the fetch falls outside the window.
    for (let i = 0; i < TRAILING_WINDOW_TURNS; i++) {
      lines.push(makeUserLine(), makeAssistantLine(`Filler turn ${i}.`));
    }
    // Claim turn + trailing current prompt (the real hook-invocation shape).
    lines.push(
      makeUserLine(),
      makeAssistantLine("The review came back: APPROVED."),
      makeUserLine()
    );
    const turn = extractLastAssistantTurn(lines as never);
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    expect(windowTools.has(WAIT_TOOL)).toBe(false);
    const matches = detectPreNarration(turn, windowTools);
    expect(matches.some((m) => m.category === "review-approved")).toBe(true);
  });

  test("extractWindowToolUseNames collects tools from current and prior in-window turns", () => {
    const lines = [
      makeUserLine(),
      makeAssistantToolUseLine("toolA"),
      makeUserLine(),
      makeAssistantToolUseLine("toolB"),
      makeUserLine(),
      makeAssistantLine("Current turn, no tools."),
    ];
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    expect(windowTools.has("toolA")).toBe(true);
    expect(windowTools.has("toolB")).toBe(true);
  });

  test("omitting the window parameter preserves same-turn-only semantics", () => {
    const turn = [makeAssistantLine(APPROVED_CLAIM)];
    const matches = detectPreNarration(turn as never);
    expect(matches.some((m) => m.category === "review-approved")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suppression outcome (mt#3207)
// ---------------------------------------------------------------------------

describe("suppression outcome (mt#3207)", () => {
  const WAIT_TOOL = "mcp__minsky__session_pr_wait-for-review";

  test("a claim backed by a SAME-TURN tool call is recorded as suppressed, not dropped", () => {
    const turn = [makeAssistantToolUseLine(PR_CREATE_TOOL), makeAssistantLine(CREATED_PR_CLAIM)];
    const detection = detectPreNarrationWithSuppression(turn as never);
    expect(detection.matches).toEqual([]);
    expect(detection.suppressed.map((s) => s.reason)).toEqual([SUPPRESSION_SAME_TURN_TOOL_CALL]);
    expect(detection.suppressed[0]?.category).toBe("pr-created");
  });

  test("a claim backed only by a TRAILING-WINDOW tool call names the window reason", () => {
    const lines = [
      makeUserLine(),
      makeAssistantToolUseLine(WAIT_TOOL),
      makeToolResultLine(),
      makeUserLine(),
      makeAssistantLine(APPROVED_CLAIM),
      makeUserLine(),
    ];
    const turn = extractLastAssistantTurn(lines as never);
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    const detection = detectPreNarrationWithSuppression(turn, windowTools);
    expect(detection.matches).toEqual([]);
    expect(detection.suppressed.map((s) => s.reason)).toEqual([SUPPRESSION_WINDOW_TOOL_CALL]);
  });

  test("an UNBACKED claim still fires and records an empty suppressionReasons", () => {
    const turn = [makeAssistantLine(APPROVED_CLAIM)];
    const detection = detectPreNarrationWithSuppression(turn as never);
    expect(detection.suppressed).toEqual([]);
    const record = buildPreNarrationRecord("s1", detection);
    expect(record.suppressionReasons).toEqual([]);
  });

  test("the record names the gate, and marks the suppressed claim hadMatchingTool", () => {
    const turn = [makeAssistantToolUseLine(PR_CREATE_TOOL), makeAssistantLine(CREATED_PR_CLAIM)];
    const record = buildPreNarrationRecord("s1", detectPreNarrationWithSuppression(turn as never));
    expect(record.suppressionReasons).toEqual([SUPPRESSION_SAME_TURN_TOOL_CALL]);
    const matches = record.matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    expect(matches[0]?.hadMatchingTool).toBe(true);
    expect(matches[0]?.phrase).toBeTruthy();
  });

  test("a MIXED pass counts as INJECTED — one live claim reached the operator", () => {
    // `session_pr_create` backs the pr-created claim; nothing backs the
    // review-approved one, so the reminder fires and the record must not be
    // read as suppressed by `isSuppressedRecord`.
    const turn = [
      makeAssistantToolUseLine(PR_CREATE_TOOL),
      makeAssistantLine(`${CREATED_PR_CLAIM} ${APPROVED_CLAIM}`),
    ];
    const detection = detectPreNarrationWithSuppression(turn as never);
    expect(detection.matches).toHaveLength(1);
    expect(detection.suppressed).toHaveLength(1);
    expect(buildPreNarrationRecord("s1", detection).suppressionReasons).toEqual([]);
  });

  test("run(): a suppressed-only turn records and injects nothing", () => {
    const lines = [
      makeUserLine(),
      makeAssistantToolUseLine(PR_CREATE_TOOL),
      makeToolResultLine(),
      makeAssistantLine(CREATED_PR_CLAIM),
      makeUserLine(),
    ];
    const outcome = run(
      { transcript_path: "/x", session_id: "s1" } as ClaudeHookInput,
      {
        transcriptLines: lines,
      } as unknown as DispatchContext
    );
    expect(outcome?.additionalContext).toBeUndefined();
    expect((outcome?.calibration as Record<string, unknown>).suppressionReasons).toEqual([
      SUPPRESSION_SAME_TURN_TOOL_CALL,
    ]);
  });

  test("run(): a turn with no claim at all still records nothing", () => {
    const lines = [makeUserLine(), makeAssistantLine("Reading the auth module."), makeUserLine()];
    const outcome = run(
      { transcript_path: "/x", session_id: "s1" } as ClaudeHookInput,
      {
        transcriptLines: lines,
      } as unknown as DispatchContext
    );
    expect(outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Match context capture (mt#3198)
// ---------------------------------------------------------------------------

describe("match context capture (mt#3198)", () => {
  // The two shapes the bare phrase cannot separate. Both match the same
  // pattern and yield the IDENTICAL phrase "merged PR"; only the surrounding
  // sentence says whether the agent claimed a merge or referred to one.
  const REFERENCE_TURN = "The merged PR touches the auth module, so I re-read it.";
  const CLAIM_TURN = "I already merged PR #2603 to unblock the deploy.";
  const MERGE_TOOL = "mcp__minsky__session_pr_merge";

  function firstMatch(text: string) {
    const matches = detectPreNarration([makeAssistantLine(text)] as never);
    const merged = matches.find((m) => m.category === "merged");
    if (merged === undefined) throw new Error(`expected a 'merged' match for: ${text}`);
    return merged;
  }

  test("the defect: reference and claim produce the SAME phrase", () => {
    expect(firstMatch(REFERENCE_TURN).matchedPhrase).toBe("merged PR");
    expect(firstMatch(CLAIM_TURN).matchedPhrase).toBe("merged PR");
  });

  test("the fix: they produce DIFFERENT context, each the containing sentence", () => {
    expect(firstMatch(REFERENCE_TURN).context).toBe(REFERENCE_TURN);
    expect(firstMatch(CLAIM_TURN).context).toBe(CLAIM_TURN);
  });

  test("context is the containing sentence only, not the neighbouring ones", () => {
    const turn =
      "I opened the branch. I already merged PR #2603 to unblock the deploy. Next up is the changelog.";
    expect(firstMatch(turn).context).toBe(CLAIM_TURN);
  });

  test("context is truncated at the documented cap", () => {
    // No sentence terminators anywhere, so the scan radius bounds the slice and
    // the cap does the rest.
    const filler = "x".repeat(400);
    const context = firstMatch(`${filler} merged PR ${filler}`).context;
    expect(context.length).toBe(MATCH_CONTEXT_MAX_CHARS);
  });

  test("context cannot capture text an elision blanked", () => {
    // The widened window is the only place pasted tool output could newly leak
    // into a committed log; extracting from the ELIDED text is what prevents it.
    const turn = "Deploying with `DATABASE_URL=postgres://u:s3cret@h/db` — merged PR now";
    const context = firstMatch(turn).context;
    expect(context).toContain("merged PR");
    expect(context).not.toContain("s3cret");
    expect(context).not.toContain("postgres://");
  });

  test("extractMatchContext falls back to the scan bounds when no sentence break exists", () => {
    const text = "no terminator here merged PR either way";
    const idx = text.indexOf("merged PR");
    expect(extractMatchContext(text, idx, "merged PR".length)).toBe(text);
  });

  test("a live (unbacked) record carries context", () => {
    const record = buildPreNarrationRecord(
      "s1",
      detectPreNarrationWithSuppression([makeAssistantLine(CLAIM_TURN)] as never)
    );
    const matches = record.matches as Array<Record<string, unknown>>;
    expect(matches[0]?.hadMatchingTool).toBe(false);
    expect(matches[0]?.context).toBe(CLAIM_TURN);
  });

  // AT7 — the mt#3207 backing contract must survive the added field.
  test("a suppressed record keeps hadMatchingTool + suppressionReason AND gains context", () => {
    const turn = [makeAssistantLine(CLAIM_TURN), makeToolUseLine(MERGE_TOOL)];
    const record = buildPreNarrationRecord("s1", detectPreNarrationWithSuppression(turn as never));
    const matches = record.matches as Array<Record<string, unknown>>;
    expect(matches[0]?.hadMatchingTool).toBe(true);
    expect(matches[0]?.suppressionReason).toBe(SUPPRESSION_SAME_TURN_TOOL_CALL);
    expect(matches[0]?.context).toBe(CLAIM_TURN);
    expect(record.suppressionReasons).toEqual([SUPPRESSION_SAME_TURN_TOOL_CALL]);
  });

  // AT6 — the reason context is a NEW field rather than a widened `phrase`.
  // Runs the real producer through the real consumer: the sweep's parser and
  // its diversity axis, not a local stand-in for them.
  describe("diversity axis (AT6)", () => {
    function parseRecordFor(text: string) {
      const record = buildPreNarrationRecord(
        "s1",
        detectPreNarrationWithSuppression([makeAssistantLine(text)] as never)
      );
      const parsed = parseCalibrationRecord(JSON.stringify(record), "pre-narration");
      if (parsed === null) throw new Error("expected the sweep to parse the record");
      return parsed as { matches: Array<{ phrase: string; context?: string }> };
    }

    test("differing contexts do NOT inflate the distinct-phrase count", () => {
      const records = [parseRecordFor(REFERENCE_TURN), parseRecordFor(CLAIM_TURN)];
      // Contexts differ...
      expect(new Set(records.map((r) => r.matches[0]?.context)).size).toBe(2);
      // ...while the axis the review threshold keys on stays at one.
      const distinct = extractDistinctPhrases(records as never);
      expect(distinct.size).toBe(1);
      expect(distinct.has("merged PR")).toBe(true);
    });

    test("the sweep surfaces context as a first-class field, not inside detectorFields", () => {
      const parsed = parseRecordFor(CLAIM_TURN) as {
        matches: Array<{ context?: string; detectorFields?: Record<string, unknown> }>;
      };
      expect(parsed.matches[0]?.context).toBe(CLAIM_TURN);
      expect(parsed.matches[0]?.detectorFields?.["context"]).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// elideMarkdownContexts
// ---------------------------------------------------------------------------

describe("elideMarkdownContexts", () => {
  test("inline code span is blanked, length preserved", () => {
    const input = "see `tests pass` here";
    const out = elideMarkdownContexts(input);
    expect(out.length).toBe(input.length);
    expect(out.includes("tests pass")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTranscript / extractLastAssistantTurn
// ---------------------------------------------------------------------------

describe("transcript parsing", () => {
  test("nonexistent path → []", () => {
    expect(parseTranscript("/no/such/file.jsonl").length).toBe(0);
  });

  test("malformed JSON lines are skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "pn-parse-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, "not json\n{bad\n", "utf8");
    try {
      expect(parseTranscript(p).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extractLastAssistantTurn returns lines between the last two user messages", () => {
    const lines = [makeUserLine(), makeAssistantLine("Created PR #1."), makeUserLine()];
    const turn = extractLastAssistantTurn(lines);
    expect(turn.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Category config sanity
// ---------------------------------------------------------------------------

describe("OUTCOME_CATEGORIES", () => {
  test("every category has patterns, requiredTools, and an expectedTool", () => {
    for (const c of OUTCOME_CATEGORIES) {
      expect(c.patterns.length).toBeGreaterThan(0);
      expect(c.requiredTools.length).toBeGreaterThan(0);
      expect(typeof c.expectedTool).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// E2E (Bun.spawn) — fail-open + override
// ---------------------------------------------------------------------------

describe("pre-narration-detector E2E", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pn-e2e-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("malformed transcript → exit 0, no output", async () => {
    const p = join(dir, "bad.jsonl");
    writeFileSync(p, "not json at all\n", "utf8");
    const { exitCode, stdout } = await invokeHook(makeHookInput(p));
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("flagged claim → exit 0, additionalContext emitted", async () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine(CREATED_PR_CLAIM), makeUserLine()]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeHook(makeHookInput(p));
    expect(exitCode).toBe(0);
    // Updated expectation (mt#3485): the reminder's first line is now the
    // standard's guard-id header, `[pre-narration-detector] ...`, replacing the
    // old "**Possible pre-narrated / fabricated tool outcome (mt#2197 ...)**"
    // banner whose provenance moved to buildReminder's doc comment. Asserting
    // the guard-id header keeps this test's intent — "the guard emitted its
    // reminder" — pinned to the part of the shape that is now mandated.
    expect(stdout).toContain("[pre-narration-detector]");
  });

  test("multi-round turn: 'PR created' claim + minting tool split by a tool_result → not flagged", async () => {
    // The minting tool (session_pr_create) ran in an EARLIER segment of the
    // same logical turn; the claim sits in a LATER segment after a tool_result.
    // The shared turn extractor spans the whole turn, so the tool is in scope
    // and the claim is backed — no pre-narration false positive (mt#2255).
    const p = join(dir, "multiround.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([
        makeUserLine(),
        makeAssistantLine("Calling create now."),
        makeAssistantToolUseLine(PR_CREATE_TOOL),
        makeToolResultLine(),
        makeAssistantLine(CREATED_PR_CLAIM),
        makeUserLine(),
      ]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeHook(makeHookInput(p));
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("override env var → exit 0, audit line, no JSON envelope", async () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine(CREATED_PR_CLAIM), makeUserLine()]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeHook(makeHookInput(p), { [OVERRIDE_ENV_VAR]: "1" });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OVERRIDE");
    expect(stdout).not.toContain("hookSpecificOutput");
  });
});

// ---------------------------------------------------------------------------
// run() — dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652)
// ---------------------------------------------------------------------------

describe("run() (dispatcher-compatible)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pn-run-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeCtx(transcriptPath: string): DispatchContext {
    return {
      event: "UserPromptSubmit",
      hostCapSec: 15,
      budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
      transcriptCandidates: [transcriptPath],
      transcriptLines: parseTranscript(transcriptPath),
    };
  }

  test("flagged claim -> additionalContext + calibration record", () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine(CREATED_PR_CLAIM), makeUserLine()]),
      "utf8"
    );
    const outcome = run(makeHookInput(p), makeCtx(p));
    // mt#3485: guard-id header replaces the old "pre-narrated" banner phrase.
    expect(outcome?.additionalContext).toContain("[pre-narration-detector]");
    expect(outcome?.calibration).toBeDefined();
  });

  test("no match -> null (silent allow)", () => {
    const p = join(dir, "noclaim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine("Nothing here."), makeUserLine()]),
      "utf8"
    );
    expect(run(makeHookInput(p), makeCtx(p))).toBeNull();
  });

  test("legacy override env var suppresses detection and returns an audit line", () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine(CREATED_PR_CLAIM), makeUserLine()]),
      "utf8"
    );
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(makeHookInput(p), makeCtx(p));
      expect(outcome?.additionalContext).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});
