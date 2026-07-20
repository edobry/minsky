import { describe, test, expect } from "bun:test";
import {
  isSessionWork,
  hasWatermark,
  isReadOnlySubagentType,
  shouldDeny,
  SESSION_WRITE_TOOLS,
} from "./check-prompt-watermark";
import { buildDispatchRecoveryContinuationPrompt } from "../../packages/domain/src/session/dispatch-recovery-classifier";
import { generateSubagentPrompt } from "../../packages/domain/src/session/prompt-generation";

/** Shared fixture: a prompt referencing a session workspace path (no watermark). */
const SESSION_WORK_PROMPT = "cd /Users/x/.local/state/minsky/sessions/abc-123 && ls";

// ---------------------------------------------------------------------------
// mt#2653: import.meta.main guard regression check
//
// Prior to mt#2653, the module ran its I/O (readInput() — blocks on stdin)
// and process.exit(0) at the top level, unconditionally on import. Importing
// it from a test would hang waiting on stdin (or exit the test process
// outright). Reaching the assertion below proves the runtime logic is now
// gated behind `if (import.meta.main)` and the import is side-effect free.
// ---------------------------------------------------------------------------

describe("check-prompt-watermark — module import safety", () => {
  test("importing the module performs no I/O and does not exit", async () => {
    const mod = await import("./check-prompt-watermark");
    // A real assertion on the imported surface (not a placeholder) — proves
    // the module resolved to the expected exports rather than merely "not
    // throwing".
    expect(typeof mod.shouldDeny).toBe("function");
    expect(mod.SESSION_WRITE_TOOLS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// isSessionWork
// ---------------------------------------------------------------------------

describe("isSessionWork", () => {
  test("detects a session workspace path", () => {
    expect(isSessionWork(SESSION_WORK_PROMPT)).toBe(true);
  });

  test("detects a fully-qualified session write tool name", () => {
    expect(isSessionWork("Now call mcp__minsky__session_commit with all: true")).toBe(true);
  });

  test("does not match plain English mentions of 'session'", () => {
    expect(isSessionWork("Please start a new session and commit your changes.")).toBe(false);
  });

  test("every declared session write tool is individually detected", () => {
    for (const tool of SESSION_WRITE_TOOLS) {
      expect(isSessionWork(`Call ${tool} now`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// hasWatermark
// ---------------------------------------------------------------------------

describe("hasWatermark", () => {
  test("detects the watermark string", () => {
    expect(hasWatermark("<!-- minsky:prompt:v1 -->\nDo the work.")).toBe(true);
  });

  test("returns false when watermark is absent", () => {
    expect(hasWatermark("Do the work.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isReadOnlySubagentType
// ---------------------------------------------------------------------------

describe("isReadOnlySubagentType", () => {
  test("recognizes each declared read-only type", () => {
    for (const t of ["Explore", "claude-code-guide", "auditor", "Plan"]) {
      expect(isReadOnlySubagentType(t)).toBe(true);
    }
  });

  test("returns false for a write-capable type", () => {
    expect(isReadOnlySubagentType("general-purpose")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldDeny
// ---------------------------------------------------------------------------

describe("shouldDeny", () => {
  test("denies session work without watermark", () => {
    expect(shouldDeny(SESSION_WORK_PROMPT, "general-purpose")).toBe(true);
  });

  test("permits session work WITH watermark", () => {
    expect(shouldDeny(`<!-- minsky:prompt:v1 -->\n${SESSION_WORK_PROMPT}`, "general-purpose")).toBe(
      false
    );
  });

  test("permits non-session prompts", () => {
    expect(shouldDeny("Summarize this file.", "general-purpose")).toBe(false);
  });

  test("permits session work for a read-only subagent type even without watermark", () => {
    expect(shouldDeny(SESSION_WORK_PROMPT, "Explore")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mt#2947: tasks.dispatch-recover continuation prompt vs. this guard
//
// Prior to mt#2947, `tasks.dispatch-recover`'s continuationPrompt was a
// hand-assembled string (`buildDispatchRecoveryContinuationPrompt`'s raw
// output) that named the session workspace directory but never carried the
// `minsky:prompt:v1` watermark. The mt#2831 recovery protocol instructs
// redispatching that string VERBATIM via the Agent tool — which this guard
// denied every time, since it always matches SESSION_PATH_PATTERN and never
// carried the watermark. The fix routes the continuation narrative through
// `generateSubagentPrompt` (the same function `session.generate_prompt`
// uses), which appends the watermark. This test proves the resulting string
// is guard-valid using the REAL `shouldDeny`/`hasWatermark` logic above, not
// just an isolated substring check.
// ---------------------------------------------------------------------------

describe("mt#2947: tasks.dispatch-recover continuation prompt passes the guard", () => {
  test("a generateSubagentPrompt-wrapped recovery continuation prompt is NOT denied", () => {
    const sessionDir = "/Users/x/.local/state/minsky/sessions/session-abc";

    const recoveryInstructions = buildDispatchRecoveryContinuationPrompt({
      taskId: "mt#9999",
      sessionId: "session-abc",
      sessionDir,
      agentType: "implementer",
      classification: "crashed-no-output",
      dirtyFileCount: 0,
      commitsAheadOfBase: 0,
      handoffExists: false,
      handoffFirstLines: [],
      prNumber: null,
      prUrl: null,
      latestReviewState: null,
      attemptNumber: 2,
      originalStartedAt: "2026-07-17T10:00:00Z",
    });

    // Sanity: the raw (unwrapped) recovery narrative alone WOULD have been
    // denied before mt#2947 — proves the guard-pass assertion below isn't
    // vacuously true because the prompt never looked like session work.
    expect(isSessionWork(recoveryInstructions)).toBe(true);
    expect(shouldDeny(recoveryInstructions, "implementer")).toBe(true);

    const { prompt } = generateSubagentPrompt({
      sessionDir,
      sessionId: "session-abc",
      taskId: "mt#9999",
      type: "implementation",
      instructions: recoveryInstructions,
    });

    expect(hasWatermark(prompt)).toBe(true);
    expect(isSessionWork(prompt)).toBe(true);
    expect(shouldDeny(prompt, "implementer")).toBe(false);
  });
});
