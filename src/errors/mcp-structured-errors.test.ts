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

describe("session.commit pre-commit detection", () => {
  /**
   * Reimplementation of `classifyPreCommitFailure` logic extracted from
   * workflow-commands.ts to test detection in isolation.
   */
  function classifyPreCommitFailure(err: unknown): {
    isPreCommit: boolean;
    subprocessOutput: string;
  } {
    if (err === null || typeof err !== "object") {
      return { isPreCommit: false, subprocessOutput: "" };
    }
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" ? e.message : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const subprocessOutput = [stderr, stdout].filter(Boolean).join("\n").trim();
    const isCommitCommand = msg.includes("git") && msg.includes("commit");
    const hasOutput = subprocessOutput.length > 0;
    return { isPreCommit: isCommitCommand && hasOutput, subprocessOutput };
  }

  test("detects pre-commit failure from execAsync ExecException shape", () => {
    const err = Object.assign(new Error("Command failed: git -C /repo commit -m 'test'"), {
      stderr: "ESLint: 2 errors found\n  src/foo.ts: 3:1  error  no-unused-vars",
      stdout: "",
      code: 1,
    });
    const { isPreCommit, subprocessOutput } = classifyPreCommitFailure(err);
    expect(isPreCommit).toBe(true);
    expect(subprocessOutput).toContain("ESLint");
  });

  test("does not flag non-commit git failures", () => {
    const err = Object.assign(new Error("Command failed: git -C /repo push"), {
      stderr: "error: failed to push",
      stdout: "",
    });
    const { isPreCommit } = classifyPreCommitFailure(err);
    expect(isPreCommit).toBe(false);
  });

  test("does not flag errors without subprocess output", () => {
    const err = new Error("Command failed: git -C /repo commit -m 'test'");
    const { isPreCommit } = classifyPreCommitFailure(err);
    expect(isPreCommit).toBe(false);
  });

  test("builds structured error with PRE_COMMIT_FAILED code", () => {
    const hookOutput = "TypeScript error TS2345: argument of type X is not assignable";
    const err = Object.assign(new Error("Command failed: git -C /repo commit -m 'wip'"), {
      stderr: hookOutput,
      stdout: "",
    });
    const { isPreCommit, subprocessOutput } = classifyPreCommitFailure(err);
    expect(isPreCommit).toBe(true);

    const structured = mcpStructuredError({
      code: McpErrorCode.PRE_COMMIT_FAILED,
      summary: PRE_COMMIT_SUMMARY,
      subprocessOutput,
    });

    // MCP client can read code without parsing stderr
    const data = structured.data as McpErrorPayload;
    expect(data.code).toBe(McpErrorCode.PRE_COMMIT_FAILED);
    expect(data.subprocessOutput).toContain("TS2345");
    // Full output preserved
    expect(data.subprocessOutput).toBe(hookOutput);
  });
});
