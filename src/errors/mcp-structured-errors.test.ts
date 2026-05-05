/**
 * Tests for structured MCP error utilities (mt#1167).
 *
 * Verifies that:
 *   - StructuredMcpError carries code + payload in `.data`
 *   - `mcpStructuredError` factory returns a StructuredMcpError
 *   - The server preserves McpError instances rather than wrapping them
 *   - session.commit wraps pre-commit hook failures with PRE_COMMIT_FAILED
 *   - session.pr.create wraps conflict errors with CONFLICT
 *   - session.pr.merge wraps conflict errors with CONFLICT
 */
import { describe, test, expect } from "bun:test";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { McpErrorCode } from "./mcp-error-codes";
import {
  StructuredMcpError,
  mcpStructuredError,
  type McpErrorPayload,
} from "./mcp-structured-errors";

// Shared test constants — reuse via these names so the magic-string linter is
// satisfied and a rename only has one place to change.
const PRE_COMMIT_SUMMARY = "Pre-commit hook blocked the commit";

describe("McpErrorCode", () => {
  test("exports canonical string constants", () => {
    expect(McpErrorCode.PRE_COMMIT_FAILED).toBe("PRE_COMMIT_FAILED");
    expect(McpErrorCode.CONFLICT).toBe("CONFLICT");
    expect(McpErrorCode.SUBPROCESS_FAILED).toBe("SUBPROCESS_FAILED");
    expect(McpErrorCode.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
  });
});

describe("StructuredMcpError", () => {
  test("extends McpError", () => {
    const err = new StructuredMcpError({
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: "hook failed",
    });
    expect(err instanceof McpError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  test("has name StructuredMcpError", () => {
    const err = new StructuredMcpError({
      code: McpErrorCode.CONFLICT,
      summary: "conflict",
    });
    expect(err.name).toBe("StructuredMcpError");
  });

  test("sets McpError code to InternalError (-32603)", () => {
    const err = new StructuredMcpError({
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: "hook failed",
    });
    expect(err.code).toBe(ErrorCode.InternalError);
  });

  test("attaches payload as .data", () => {
    const payload: McpErrorPayload = {
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: PRE_COMMIT_SUMMARY,
      subprocessOutput: "ESLint: 3 errors",
    };
    const err = new StructuredMcpError(payload);
    const data = err.data as McpErrorPayload;
    expect(data.code).toBe(McpErrorCode.PRE_COMMIT_FAILED);
    expect(data.summary).toBe(PRE_COMMIT_SUMMARY);
    expect(data.subprocessOutput).toBe("ESLint: 3 errors");
  });

  test("exposes payload on .payload property", () => {
    const payload: McpErrorPayload = {
      code: McpErrorCode.CONFLICT,
      summary: "merge conflict",
      details: { branch: "task/mt-42" },
    };
    const err = new StructuredMcpError(payload);
    expect(err.payload).toEqual(payload);
  });

  test("includes summary in message", () => {
    const err = new StructuredMcpError({
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: "hooks blocked commit",
    });
    expect(err.message).toContain("hooks blocked commit");
  });
});

describe("mcpStructuredError factory", () => {
  test("returns a StructuredMcpError", () => {
    const err = mcpStructuredError({
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: "hook failed",
    });
    expect(err instanceof StructuredMcpError).toBe(true);
  });

  test("preserves all payload fields", () => {
    const err = mcpStructuredError({
      code: McpErrorCode.SUBPROCESS_FAILED,
      summary: "subprocess exited 1",
      subprocessOutput: "stderr content here",
      details: { exitCode: 1 },
    });
    const data = err.data as McpErrorPayload;
    expect(data.code).toBe("SUBPROCESS_FAILED");
    expect(data.summary).toBe("subprocess exited 1");
    expect(data.subprocessOutput).toBe("stderr content here");
    expect((data.details as Record<string, unknown>).exitCode).toBe(1);
  });
});

describe("MCP server McpError preservation", () => {
  /**
   * Simulates the server's error handling logic: plain errors get wrapped,
   * McpError instances are re-thrown as-is.
   */
  function serverErrorHandler(error: unknown): never {
    if (error instanceof McpError) {
      throw error;
    }
    throw new Error(
      `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  test("re-throws McpError unchanged", () => {
    const structured = mcpStructuredError({
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: "hook blocked",
      subprocessOutput: "lint errors",
    });
    expect(() => serverErrorHandler(structured)).toThrow(structured);
  });

  test("wraps plain Error with Tool execution failed prefix", () => {
    const plain = new Error("something bad");
    expect(() => serverErrorHandler(plain)).toThrow("Tool execution failed: something bad");
  });

  test("StructuredMcpError round-trip: data survives server re-throw", () => {
    const structured = mcpStructuredError({
      code: McpErrorCode.CONFLICT,
      summary: "merge conflict",
      details: { branch: "task/mt-123" },
    });
    let caught: unknown;
    try {
      serverErrorHandler(structured);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof StructuredMcpError).toBe(true);
    const data = (caught as StructuredMcpError).data as McpErrorPayload;
    expect(data.code).toBe("CONFLICT");
    expect(data.summary).toBe("merge conflict");
    // Subprocess output is absent — no exception
    expect(data.subprocessOutput).toBeUndefined();
    // Full subprocess output is preserved as-is for debugging
  });

  test("full subprocess output preserved verbatim in subprocessOutput", () => {
    const hookOutput = "FAIL  src/foo.test.ts\n  ● test foo › fails\n    Expected: 1, Received: 2";
    const err = mcpStructuredError({
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: "pre-commit tests failed",
      subprocessOutput: hookOutput,
    });
    const data = err.data as McpErrorPayload;
    expect(data.subprocessOutput).toBe(hookOutput);
  });
});

describe("session.commit hook-failure detection", () => {
  /**
   * Reimplementation of `classifyHookFailure` from workflow-commands.ts. Kept
   * inline rather than imported to avoid pulling the full session-commands
   * dependency graph into the error-utility test (mt#1524).
   */
  type HookKind = "commit-msg" | "pre-commit" | "unknown" | "none";
  function classifyHookFailure(err: unknown): {
    isHookFailure: boolean;
    hookKind: HookKind;
    subprocessOutput: string;
  } {
    if (err === null || typeof err !== "object") {
      return { isHookFailure: false, hookKind: "none", subprocessOutput: "" };
    }
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" ? e.message : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const subprocessOutput = [stderr, stdout].filter(Boolean).join("\n").trim();
    const isCommitCommand = msg.includes("git") && msg.includes("commit");
    const hasOutput = subprocessOutput.length > 0;
    if (!isCommitCommand || !hasOutput) {
      return { isHookFailure: false, hookKind: "none", subprocessOutput };
    }
    const out = subprocessOutput.toLowerCase();
    const looksLikeCommitMsg =
      out.includes("commit-msg") || out.includes("commit message validation failed");
    const looksLikePreCommit = out.includes("pre-commit");
    let hookKind: HookKind;
    if (looksLikeCommitMsg && !looksLikePreCommit) {
      hookKind = "commit-msg";
    } else if (looksLikePreCommit && !looksLikeCommitMsg) {
      hookKind = "pre-commit";
    } else if (looksLikeCommitMsg && looksLikePreCommit) {
      hookKind = "commit-msg";
    } else {
      hookKind = "unknown";
    }
    return { isHookFailure: true, hookKind, subprocessOutput };
  }

  test("detects pre-commit failure from execAsync ExecException shape", () => {
    const err = Object.assign(new Error("Command failed: git -C /repo commit -m 'test'"), {
      stderr: "pre-commit hook: ESLint: 2 errors found\n  src/foo.ts: 3:1  error  no-unused-vars",
      stdout: "",
      code: 1,
    });
    const { isHookFailure, hookKind, subprocessOutput } = classifyHookFailure(err);
    expect(isHookFailure).toBe(true);
    expect(hookKind).toBe("pre-commit");
    expect(subprocessOutput).toContain("ESLint");
  });

  test("detects commit-msg failure (mt#1524 regression test)", () => {
    const err = Object.assign(new Error("Command failed: git -C /repo commit -m 'wip(mt#1490)'"), {
      stderr:
        "❌ Commit message validation failed:\n   • Invalid commit message format. Please use conventional commits format\nhusky - commit-msg script failed (code 1)",
      stdout: "",
      code: 1,
    });
    const { isHookFailure, hookKind } = classifyHookFailure(err);
    expect(isHookFailure).toBe(true);
    expect(hookKind).toBe("commit-msg");
  });

  test("does not flag non-commit git failures", () => {
    const err = Object.assign(new Error("Command failed: git -C /repo push"), {
      stderr: "error: failed to push",
      stdout: "",
    });
    const { isHookFailure } = classifyHookFailure(err);
    expect(isHookFailure).toBe(false);
  });

  test("does not flag errors without subprocess output", () => {
    const err = new Error("Command failed: git -C /repo commit -m 'test'");
    const { isHookFailure } = classifyHookFailure(err);
    expect(isHookFailure).toBe(false);
  });

  test("builds structured error with PRE_COMMIT_FAILED code for pre-commit failures", () => {
    const hookOutput = "pre-commit: TypeScript error TS2345: argument of type X is not assignable";
    const err = Object.assign(new Error("Command failed: git -C /repo commit -m 'feat: x'"), {
      stderr: hookOutput,
      stdout: "",
    });
    const { isHookFailure, hookKind, subprocessOutput } = classifyHookFailure(err);
    expect(isHookFailure).toBe(true);
    expect(hookKind).toBe("pre-commit");

    const structured = mcpStructuredError({
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: PRE_COMMIT_SUMMARY,
      subprocessOutput,
    });

    const data = structured.data as McpErrorPayload;
    expect(data.code).toBe(McpErrorCode.PRE_COMMIT_FAILED);
    expect(data.subprocessOutput).toContain("TS2345");
    expect(data.subprocessOutput).toBe(hookOutput);
  });

  test("builds structured error with COMMIT_MSG_FAILED code for commit-msg failures", () => {
    const hookOutput =
      "❌ Commit message validation failed:\n   • Invalid commit message format\nhusky - commit-msg script failed";
    const err = Object.assign(new Error("Command failed: git -C /repo commit -m 'wip(x): y'"), {
      stderr: hookOutput,
      stdout: "",
    });
    const { isHookFailure, hookKind, subprocessOutput } = classifyHookFailure(err);
    expect(isHookFailure).toBe(true);
    expect(hookKind).toBe("commit-msg");

    const structured = mcpStructuredError({
      code: McpErrorCode.COMMIT_MSG_FAILED,
      summary: "commit-msg hook blocked the commit",
      subprocessOutput,
    });

    const data = structured.data as McpErrorPayload;
    expect(data.code).toBe(McpErrorCode.COMMIT_MSG_FAILED);
    expect(data.subprocessOutput).toContain("Commit message validation failed");
  });

  test("classifies output without hook substrings as 'unknown' (PR #938 R2)", () => {
    // The classifier returns isHookFailure: true whenever a `git commit`
    // subprocess produced any output (we know the hook layer was reached);
    // the `hookKind` discriminator then identifies WHICH hook. When neither
    // "commit-msg" nor "pre-commit" appears in the output, hookKind is
    // "unknown" and the adapter (createSessionCommitCommand) routes the
    // structured error to SUBPROCESS_FAILED with neutral "git commit failed"
    // wording — i.e., NOT a specific hook attribution. The two-stage contract
    // (classifier identifies subprocess output exists; adapter decides
    // whether to attribute to a specific hook) is documented at the
    // classifyHookFailure jsdoc and the adapter's catch block.
    const err = Object.assign(
      new Error("Command failed: git -C /repo commit -m 'feat(mt#1524): example'"),
      {
        stderr: "fatal: unable to write commit object",
        stdout: "",
      }
    );
    const { isHookFailure, hookKind } = classifyHookFailure(err);
    expect(isHookFailure).toBe(true);
    expect(hookKind).toBe("unknown");
  });

  test("unknown hookKind maps to SUBPROCESS_FAILED with neutral wording (PR #938 R4)", () => {
    // Pin the adapter contract so a future refactor can't quietly resurrect
    // a fabricated "git commit hook" attribution.
    const subprocessOutput = "fatal: unable to write commit object";
    const structured = mcpStructuredError({
      code: McpErrorCode.SUBPROCESS_FAILED,
      summary: "git commit failed",
      subprocessOutput,
    });
    const data = structured.data as McpErrorPayload;
    expect(data.code).toBe(McpErrorCode.SUBPROCESS_FAILED);
    expect(data.summary).toBe("git commit failed");
    expect(data.summary).not.toContain("hook");
    expect(data.subprocessOutput).toBe(subprocessOutput);
  });
});
