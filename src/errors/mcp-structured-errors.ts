/**
 * Structured MCP error utilities.
 *
 * Provides a `StructuredMcpError` class and a `mcpStructuredError` factory that
 * produce MCP-protocol errors carrying a machine-readable payload in the `data`
 * field. External agents can branch on `error.data.code` rather than
 * regex-parsing `error.message`.
 *
 * Usage:
 *   throw mcpStructuredError({
 *     code: McpErrorCode.PRE_COMMIT_FAILED,
 *     summary: "Pre-commit hook failed",
 *     subprocessOutput: hookStderr,
 *   });
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { type McpErrorCodeValue } from "./mcp-error-codes";

/**
 * Structured payload attached to the `data` field of a `StructuredMcpError`.
 * External agents read these fields; do NOT rely on the human-readable `message`.
 */
export interface McpErrorPayload {
  /** Machine-readable error code. Branch on this, not on the message string. */
  code: McpErrorCodeValue;
  /** Short human-readable summary (≤ 120 chars). Safe to display in UI. */
  summary: string;
  /**
   * Full stdout/stderr from a subprocess that caused the failure, preserved
   * verbatim for debugging. Only present when a subprocess was involved.
   */
  subprocessOutput?: string;
  /** Additional structured detail, specific to the error type. */
  details?: Record<string, unknown>;
}

/**
 * An MCP-protocol error that carries a structured payload in `data`.
 *
 * The MCP SDK propagates `McpError` instances through the JSON-RPC layer
 * with `code` and `data` intact. Plain `Error` objects are collapsed to
 * `InternalError` + string message, losing the structured payload.
 *
 * `StructuredMcpError` uses `ErrorCode.InternalError` (-32603) at the JSON-RPC
 * layer — there is no purpose-specific JSON-RPC code for tool failures. The
 * domain-level discrimination happens via `data.code`.
 */
export class StructuredMcpError extends McpError {
  /** The structured payload that callers should inspect. */
  readonly payload: McpErrorPayload;

  constructor(payload: McpErrorPayload) {
    super(ErrorCode.InternalError, payload.summary, payload);
    this.payload = payload;
    this.name = "StructuredMcpError";
  }
}

/**
 * Factory: create and return a `StructuredMcpError` ready to be thrown.
 *
 * @example
 * throw mcpStructuredError({
 *   code: McpErrorCode.PRE_COMMIT_FAILED,
 *   summary: "Pre-commit hook failed",
 *   subprocessOutput: hookStderr,
 * });
 */
export function mcpStructuredError(payload: McpErrorPayload): StructuredMcpError {
  return new StructuredMcpError(payload);
}
