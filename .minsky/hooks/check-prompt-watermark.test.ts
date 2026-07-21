import { describe, test, expect } from "bun:test";
import {
  isSessionWork,
  hasWatermark,
  isReadOnlySubagentType,
  shouldDeny,
  SESSION_WRITE_TOOLS,
} from "./check-prompt-watermark";

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
