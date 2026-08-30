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
  SUPPRESSION_IDENTITY_SCOPED_TOOL_CALL,
  SUPPRESSION_SAME_TURN_TOOL_CALL,
  SUPPRESSION_WINDOW_TOOL_CALL,
  TRAILING_WINDOW_TURNS,
  withBareToolAliases,
  run,
  renderWorstCase,
  buildIdentityEvidence,
  extractClaimedPrNumber,
  extractPrNumbersForTools,
  identityScopedToolNames,
} from "./pre-narration-detector";
import {
  extractDistinctPhrases,
  isSuppressedRecord,
  parseCalibrationRecord,
} from "../../src/domain/calibration/calibration-sweep";
import { parseTranscript, extractLastAssistantTurn } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

const CREATED_PR_CLAIM = "Created PR #4242.";
const APPROVED_CLAIM = "The review came back: APPROVED, no findings.";
const PR_CREATE_TOOL = "mcp__minsky__session_pr_create";
const PR_MERGE_TOOL = "mcp__minsky__session_pr_merge";
const PR_READ_TOOL_NAME = "mcp__github__pull_request_read";
const MERGED_CLAIM_3033 = "PR #3033 merged.";

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
  const MERGE_TOOL = PR_MERGE_TOOL;

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

  // AT1 (main path) — mt#4286. This test previously asserted the OPPOSITE:
  // `expect(stdout).toContain("[pre-narration-detector]")`, i.e. that a flagged
  // claim emitted the reminder. That was correct until the guard was quieted to
  // log-only per ask#9219; the same fixture is kept so the inversion is visible
  // in the diff rather than the test being deleted and replaced.
  //
  // Negative control for the quieting: this exact fixture, run against the tree
  // before `INJECTION_ENABLED` existed, emitted 581 chars of `additionalContext`.
  test("flagged claim → exit 0, quieted: no reminder on stdout (mt#4286)", async () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine(CREATED_PR_CLAIM), makeUserLine()]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeHook(makeHookInput(p));
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(stdout).not.toContain("hookSpecificOutput");
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

  // AT1 (dispatcher path) — mt#4286. Previously asserted
  // `expect(outcome?.additionalContext).toContain("[pre-narration-detector]")`.
  // The RECORD half of the old assertion is deliberately kept and strengthened:
  // quieting must not cost the corpus, because mt#4256 measures against it.
  test("flagged claim -> calibration record, quieted: NO additionalContext (mt#4286)", () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine(CREATED_PR_CLAIM), makeUserLine()]),
      "utf8"
    );
    const outcome = run(makeHookInput(p), makeCtx(p));
    expect(outcome?.additionalContext).toBeUndefined();
    expect(outcome?.calibration).toBeDefined();
  });

  // AT2 — the record survives the quieting intact. Each field is asserted by
  // name rather than by a snapshot, so a future edit that drops one fails here
  // instead of silently shrinking the corpus mt#4256 is measured against.
  test("AT2: the calibration record keeps every field, plus injection_enabled (mt#4286)", () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine(CREATED_PR_CLAIM), makeUserLine()]),
      "utf8"
    );
    const record = run(makeHookInput(p), makeCtx(p))?.calibration as Record<string, unknown>;
    expect(record).toBeDefined();
    expect(record.injection_enabled).toBe(false);
    expect(record.session_id).toBe("test-session-pre-narration");
    const matches = record.matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      category: "pr-created",
      phrase: "Created PR",
      hadMatchingTool: false,
    });
    expect(matches[0]?.context).toBeTypeOf("string");
    expect(matches[0]?.expectedTool).toBeTypeOf("string");
  });

  // AT3 — mt#3207's suppressed-only behavior is unchanged by the flag: such a
  // pass recorded and did not inject before, and still does exactly that.
  test("AT3: a suppressed-only pass still records and still injects nothing (mt#4286)", () => {
    const p = join(dir, "suppressed.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([
        makeUserLine(),
        makeAssistantToolUseLine(PR_CREATE_TOOL),
        makeToolResultLine(),
        makeAssistantLine(CREATED_PR_CLAIM),
        makeUserLine(),
      ]),
      "utf8"
    );
    const outcome = run(makeHookInput(p), makeCtx(p));
    expect(outcome?.additionalContext).toBeUndefined();
    const record = outcome?.calibration as Record<string, unknown>;
    expect(record).toBeDefined();
    expect(record.suppressionReasons).toEqual([SUPPRESSION_SAME_TURN_TOOL_CALL]);
  });

  // AT4 — the load-bearing one. `isSuppressedRecord` is what the review
  // thresholds key on via `injectedFiresSinceLastReview`. If quieting made a
  // matched pass read as SUPPRESSED, the log would stop becoming review-due and
  // mt#4256 — this quieting's own retirement condition — would never be
  // prompted. Gating only `additionalContext` is what keeps this true.
  test("AT4: a quieted fire still counts as a fire, not a suppression (mt#4286)", () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildTranscriptJSONL([makeUserLine(), makeAssistantLine(CREATED_PR_CLAIM), makeUserLine()]),
      "utf8"
    );
    const record = run(makeHookInput(p), makeCtx(p))?.calibration as Record<string, unknown>;
    const parsed = parseCalibrationRecord(JSON.stringify(record), "pre-narration");
    if (parsed === null)
      throw new Error("the quieted record failed to parse as a calibration record");
    expect(isSuppressedRecord(parsed)).toBe(false);
  });

  // The quieting is a GATE, not a deletion — `buildReminder` still works and is
  // still exercised, via the renderProbe the registration now declares. Without
  // this, "quieted" and "the reminder builder rotted" look identical.
  test("renderWorstCase still renders, and exceeds the pre-mt#4286 ceiling", () => {
    const rendered = renderWorstCase();
    expect(rendered).toContain("[pre-narration-detector]");
    // One line per category — the axis the old "fixed" shape classification and
    // the old 650 annotation both missed.
    for (const category of OUTCOME_CATEGORIES) {
      expect(rendered).toContain(`**${category.key}**`);
    }
    expect(rendered.length).toBeGreaterThan(650);
    expect(rendered.length).toBeLessThanOrEqual(1800);
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

// ---------------------------------------------------------------------------
// mt#3864 — measured false-positive classes
//
// Every fixture below is grounded in a MEASURED record, not an invented shape.
// The evidence is `scripts/diagnose-pre-narration-window.ts`, which replays each
// injected calibration record against its own session transcript; its output for
// the 2026-08-13→18 window is quoted in mt#3864 §MEASURED CAUSE.
// ---------------------------------------------------------------------------

describe("mt#3864 class 6 — a double-quoted prose span is a quotation, not an assertion", () => {
  test("APPROVED inside double quotes does not fire", () => {
    // The recorded shape: a line quoting a stored memory record's content. The
    // local markdown elision covers fences/code-spans/blockquotes and left this
    // one alone; `elideDoubleQuotedSpans` is what reaches it.
    const turn = [
      makeAssistantLine('mem#905 records that the round came back "APPROVED, 0 blocking".'),
    ];
    expect(detectPreNarration(turn as never).length).toBe(0);
  });

  test("NEGATIVE CONTROL: the same phrase unquoted still fires", () => {
    // Without this, the test above passes just as well against a matcher that
    // stopped detecting APPROVED entirely — it would assert nothing about the
    // elision.
    const turn = [makeAssistantLine("The round came back APPROVED, 0 blocking.")];
    expect(detectPreNarration(turn as never).length).toBeGreaterThan(0);
  });
});

describe("mt#3864 Cause A — reading a PR's state is evidence about THAT PR's state", () => {
  const MERGED_CLAIM = MERGED_CLAIM_3033;
  const PR_READ_TOOL = PR_READ_TOOL_NAME;
  const READ_TOOLS = new Set([PR_READ_TOOL]);
  /** Identity evidence in the shape `buildIdentityEvidence` produces. */
  const mergedEvidence = (...prs: number[]) => new Map([["merged", new Set(prs)]]);

  test("a merge claim backed by a read OF THE SAME PR is suppressed", () => {
    // Measured: "PR #3033 merged" and "PR #3064 merged" both had these tools in
    // window and no merge tool, because ANOTHER ACTOR performed the merge and
    // the agent verified it by reading. Both claims were true.
    const turn = [makeAssistantLine(MERGED_CLAIM)];
    expect(detectPreNarration(turn as never, READ_TOOLS, mergedEvidence(3033)).length).toBe(0);
  });

  test("R3: an identity-backed suppression names its OWN reason, not the window's", () => {
    // The reason strings exist so a calibration reviewer can tell the sources
    // apart from the record alone. Identity-scoped is reached only when NO
    // `requiredTools` call was in window, so recording it as `window-tool-call`
    // would name a call that never happened.
    const turn = [makeAssistantLine(MERGED_CLAIM)];
    const detection = detectPreNarrationWithSuppression(
      turn as never,
      READ_TOOLS,
      mergedEvidence(3033)
    );
    expect(detection.matches).toEqual([]);
    expect(detection.suppressed.map((s) => s.reason)).toEqual([
      SUPPRESSION_IDENTITY_SCOPED_TOOL_CALL,
    ]);
  });

  test("a same-turn merge tool still names the same-turn reason, not the identity one", () => {
    // Negative control for the ordering: identity evidence present AND a real
    // merge call in the turn must still record the stronger source.
    const turn = [makeAssistantToolUseLine(PR_MERGE_TOOL), makeAssistantLine(MERGED_CLAIM)];
    const detection = detectPreNarrationWithSuppression(
      turn as never,
      undefined,
      mergedEvidence(3033)
    );
    expect(detection.suppressed.map((s) => s.reason)).toEqual([SUPPRESSION_SAME_TURN_TOOL_CALL]);
  });

  test("session_pr_get counts as the same evidence", () => {
    const turn = [makeAssistantLine(MERGED_CLAIM)];
    const tools = new Set(["mcp__minsky__session_pr_get"]);
    expect(detectPreNarration(turn as never, tools, mergedEvidence(3033)).length).toBe(0);
  });

  test("BLOCKING R1: a read of a DIFFERENT PR does not suppress", () => {
    // PR #3096 R1, the finding's exact scenario. Without identity correlation,
    // reading any PR would silence a false claim about any other — and reads are
    // common enough that this would be the usual case, not a corner.
    const turn = [makeAssistantLine(MERGED_CLAIM)]; // claims #3033
    expect(
      detectPreNarration(turn as never, READ_TOOLS, mergedEvidence(100)).length
    ).toBeGreaterThan(0);
  });

  test("a claim naming NO PR number is never identity-backed", () => {
    // Correlation is impossible, so the safe degrade for a suppressor is to fire
    // (ADR-024's fail-to-Rung-1 invariant: degrade toward MORE fires).
    const turn = [makeAssistantLine("The PR is now merged.")];
    expect(
      detectPreNarration(turn as never, READ_TOOLS, mergedEvidence(3033)).length
    ).toBeGreaterThan(0);
  });

  test("NEGATIVE CONTROL: with no PR tool at all, the merge claim still fires", () => {
    // The widening must narrow the category, not disable it. Two of the four
    // measured `merged` fires had no PR tool in window and must keep firing.
    const turn = [makeAssistantLine(MERGED_CLAIM)];
    expect(detectPreNarration(turn as never, new Set()).length).toBeGreaterThan(0);
  });

  test("a LIST-shaped tool contributes no identity evidence", () => {
    // `list_pull_requests` / `session_pr_list` were in window on BOTH measured
    // cases and are deliberately excluded: a listing establishes no PARTICULAR
    // PR's state. Asserted at buildIdentityEvidence, which is the layer that
    // decides which tools contribute (it was detectPreNarration's job until R2
    // collapsed the two conditions into one).
    const lines = [
      makeUserLine(),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "mcp__github__list_pull_requests",
              input: { pullNumber: 3033 },
            },
          ],
        },
      },
      makeAssistantLine(MERGED_CLAIM),
    ];
    expect(
      buildIdentityEvidence(lines as never, 12)
        .get("merged")
        ?.has(3033) ?? false
    ).toBe(false);
  });
});

describe("mt#3864 — PR-identity helpers (PR #3096 R1)", () => {
  test("extractClaimedPrNumber reads the number a claim names", () => {
    expect(extractClaimedPrNumber("PR #3033 merged")).toBe(3033);
    expect(extractClaimedPrNumber("PR 3033 merged")).toBe(3033);
    expect(extractClaimedPrNumber("the PR is now merged")).toBeNull();
  });

  test("extractPrNumbersForTools reads identity keys from tool inputs", () => {
    const lines = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: PR_READ_TOOL_NAME,
              input: { pullNumber: 3033 },
            },
          ],
        },
      },
    ];
    const found = extractPrNumbersForTools(lines as never, [PR_READ_TOOL_NAME]);
    expect([...found]).toEqual([3033]);
  });

  test("R4: a GENERIC number key is not identity evidence", () => {
    // The key list is deliberately narrow. A spurious match manufactures
    // evidence and SUPPRESSES a fire — the unsafe degrade, and a silent one.
    // Re-widening to a generic key must be a deliberate edit that fails here.
    const lines = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: PR_READ_TOOL_NAME, input: { number: 3033, pr: 3033 } },
          ],
        },
      },
    ];
    expect([...extractPrNumbersForTools(lines as never, [PR_READ_TOOL_NAME])]).toEqual([]);
  });

  test("NEGATIVE CONTROL: the same call keyed `pullNumber` IS evidence", () => {
    // Pins that the test above measures the KEY, not a broken helper.
    const lines = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: PR_READ_TOOL_NAME, input: { pullNumber: 3033 } }],
        },
      },
    ];
    expect([...extractPrNumbersForTools(lines as never, [PR_READ_TOOL_NAME])]).toEqual([3033]);
  });

  test("identityScopedToolNames is derived from the categories, not restated", () => {
    // Guards the wiring: a tool added to a category's identityScopedTools must
    // reach the evidence-gathering side automatically.
    expect(identityScopedToolNames()).toContain(PR_READ_TOOL_NAME);
    expect(identityScopedToolNames()).toContain("mcp__minsky__session_pr_get");
  });
});

describe("mt#3864 — identity evidence is window-scoped (PR #3096 R2)", () => {
  const PR_READ = PR_READ_TOOL_NAME;

  function readOfPr(pr: number): TranscriptLine {
    return {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: PR_READ, input: { pullNumber: pr } }],
      },
    };
  }

  test("a read INSIDE the window is evidence", () => {
    const lines = [makeUserLine(), readOfPr(3033), makeAssistantLine(MERGED_CLAIM_3033)];
    const evidence = buildIdentityEvidence(lines as never, 12);
    expect(evidence.get("merged")?.has(3033)).toBe(true);
  });

  test("BLOCKING R2: a read OUTSIDE the window is NOT evidence", () => {
    // The finding: identity numbers were sourced from the whole transcript
    // while the gate only required some scoped tool in-window, so a stale read
    // could back a claim it had no current relationship to. Both halves now
    // derive from the same `windowSlice`.
    const lines: TranscriptLine[] = [readOfPr(3033)];
    for (let i = 0; i < 4; i++) lines.push(makeUserLine(), makeAssistantLine("working"));
    lines.push(makeAssistantLine(MERGED_CLAIM_3033));

    // Window of 2 real prompts cannot reach back to the read at index 0.
    expect(
      buildIdentityEvidence(lines as never, 2)
        .get("merged")
        ?.has(3033) ?? false
    ).toBe(false);
    // NEGATIVE CONTROL: a window wide enough to reach it does see it, so the
    // assertion above is about SCOPE and not about the read being unreadable.
    expect(
      buildIdentityEvidence(lines as never, 12)
        .get("merged")
        ?.has(3033)
    ).toBe(true);
  });

  test("evidence is keyed by category, so a scoped tool cannot back another category", () => {
    const lines = [makeUserLine(), readOfPr(3033), makeAssistantLine(MERGED_CLAIM_3033)];
    const evidence = buildIdentityEvidence(lines as never, 12);
    // Only `merged` declares identityScopedTools today; the others must be absent
    // rather than sharing one union set.
    expect(evidence.has("merged")).toBe(true);
    expect(evidence.has("review-approved")).toBe(false);
  });
});

describe("mt#4498 — a merge entails the approval it merged on", () => {
  const MERGE_TOOL = PR_MERGE_TOOL;

  test("an APPROVED claim backed only by a MERGE in window is suppressed", () => {
    // The entailment: `session_pr_merge` refuses a PR without an approving
    // review, so an agent that merged cannot have been pre-narrating the
    // approval. Largest addressable share of the leak — 10 of the 36
    // `review-approved` fires in the replayed corpus had exactly this shape.
    const lines = [
      makeUserLine(),
      makeAssistantToolUseLine(MERGE_TOOL),
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
    expect(detection.suppressed[0]?.category).toBe("review-approved");
  });

  test("NEGATIVE CONTROL: the same claim with NO tool in window still fires", () => {
    // Without this the change above is indistinguishable from switching the
    // category off. The fixture differs from the one above by exactly one
    // thing — the merge call — so a detector answering both the same way has
    // measured nothing.
    const lines = [makeUserLine(), makeAssistantLine(APPROVED_CLAIM), makeUserLine()];
    const turn = extractLastAssistantTurn(lines as never);
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    const detection = detectPreNarrationWithSuppression(turn, windowTools);
    expect(detection.suppressed).toEqual([]);
    expect(detection.matches.map((m) => m.category)).toEqual(["review-approved"]);
  });

  test("an unrelated tool in window does NOT suppress the claim", () => {
    // Guards the widening direction: the merge entailment must not degrade into
    // "any tool ran, so the claim is backed".
    const lines = [
      makeUserLine(),
      makeAssistantToolUseLine("mcp__minsky__tasks_get"),
      makeToolResultLine(),
      makeUserLine(),
      makeAssistantLine(APPROVED_CLAIM),
      makeUserLine(),
    ];
    const turn = extractLastAssistantTurn(lines as never);
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    const detection = detectPreNarrationWithSuppression(turn, windowTools);
    expect(detection.suppressed).toEqual([]);
    expect(detection.matches.map((m) => m.category)).toEqual(["review-approved"]);
  });
});

describe("mt#4498 — the second MCP server alias is not invisible", () => {
  test("evidence emitted under the `minsky-server` alias suppresses", () => {
    // Exact `Set.has` matching meant `mcp__minsky-server__session_pr_wait-for-review`
    // equalled neither the `mcp__minsky__…` entry nor the bare one, so every
    // result claim in a session on that alias fired. 2 of 65 tool-absent leaks.
    const lines = [
      makeUserLine(),
      makeAssistantToolUseLine("mcp__minsky-server__session_pr_wait-for-review"),
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

  test("NEGATIVE CONTROL: an unrelated tool under the same alias still fires", () => {
    // Proves the alias handling did not degrade into matching on the prefix.
    const lines = [
      makeUserLine(),
      makeAssistantToolUseLine("mcp__minsky-server__tasks_get"),
      makeToolResultLine(),
      makeUserLine(),
      makeAssistantLine(APPROVED_CLAIM),
      makeUserLine(),
    ];
    const turn = extractLastAssistantTurn(lines as never);
    const windowTools = extractWindowToolUseNames(lines as never, TRAILING_WINDOW_TURNS);
    const detection = detectPreNarrationWithSuppression(turn, windowTools);
    expect(detection.suppressed).toEqual([]);
    expect(detection.matches.map((m) => m.category)).toEqual(["review-approved"]);
  });

  test("withBareToolAliases adds the suffix without dropping the full name", () => {
    const out = withBareToolAliases(["mcp__minsky-server__session_pr_merge", "Bash"]);
    expect(out.has("mcp__minsky-server__session_pr_merge")).toBe(true);
    expect(out.has("session_pr_merge")).toBe(true);
    expect(out.has("Bash")).toBe(true);
  });
});
