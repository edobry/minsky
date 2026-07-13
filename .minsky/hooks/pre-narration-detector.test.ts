/* eslint-disable custom/no-real-fs-in-tests -- the hook reads real transcript files via fs.readFileSync and E2E tests must write real transcript JSONL files so Bun.spawn can read them */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPreNarration,
  elideMarkdownContexts,
  extractWindowToolUseNames,
  OVERRIDE_ENV_VAR,
  OUTCOME_CATEGORIES,
  TRAILING_WINDOW_TURNS,
  run,
} from "./pre-narration-detector";
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
    expect(stdout).toContain("pre-narrated");
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
    expect(outcome?.additionalContext).toContain("pre-narrated");
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
