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
import { safeTruncate } from "@minsky/shared/safe-truncate";
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
 * Cap (in chars) on how much of a subprocess-output excerpt gets folded into
 * the WIRE message (see `buildWireMessage` below). This is a defensive
 * backstop independent of any upstream truncation (e.g.
 * `SUBPROCESS_OUTPUT_TRUNCATE_LIMIT` in workflow-commands.ts) — it protects
 * any `mcpStructuredError` caller that passes a large `subprocessOutput`
 * without pre-truncating it.
 */
const WIRE_MESSAGE_TAIL_LIMIT = 2000;

/**
 * Build the message that actually reaches the MCP wire (and therefore the
 * end user / calling agent) — NOT just `payload.summary`.
 *
 * mt#2635: two live incidents showed an operator seeing ONLY
 * `payload.summary` ("pre-commit hook blocked the commit") with none of the
 * diagnostic detail that `buildSubprocessFailurePayload` already computes
 * into `payload.details.tail` / `payload.subprocessOutput` — because
 * whatever surfaced the error to the operator rendered `error.message` and
 * not `error.data`. `payload.summary` keeps its documented ≤120-char
 * UI-safe contract (still readable at `data.summary`); the WIRE message
 * appends a tail excerpt of the actual subprocess output so the failing
 * step is visible without a second round-trip to inspect `data`.
 *
 * Prefers the already-truncated `details.tail` (set by
 * `buildSubprocessFailurePayload`) over the raw `subprocessOutput`, since a
 * caller that populated `details.tail` has already made a truncation
 * decision; falls back to a fresh tail-truncation of `subprocessOutput`
 * when `details.tail` is absent (e.g. payloads built by hand, as some
 * existing callers — CONFLICT errors, tests — do).
 *
 * When `details.failingStep` is present (best-effort label computed by
 * `detectFailingStep` in workflow-commands.ts), it is prefixed onto the
 * summary line so the failing check is named explicitly, not just implied
 * by the raw tail text.
 *
 * mt#2635 PR #1811 R1: guards against duplicating the headline text when
 * the tail excerpt already contains it verbatim (e.g. a caller that sets
 * `subprocessOutput` to the SAME string as `summary`, or a hook's own
 * output happening to echo the summary phrasing) — in that case the
 * headline is dropped and the tail (which already carries the same
 * information) is returned alone, rather than reading as
 * "X\n\n...X...".
 */
function buildWireMessage(payload: McpErrorPayload): string {
  const detailsTail = payload.details?.tail;
  const tail =
    typeof detailsTail === "string" && detailsTail.length > 0
      ? detailsTail
      : payload.subprocessOutput
        ? safeTruncate(payload.subprocessOutput, WIRE_MESSAGE_TAIL_LIMIT)
        : "";
  const failingStep = payload.details?.failingStep;
  const headline =
    typeof failingStep === "string" && failingStep.length > 0
      ? `${payload.summary} (${failingStep})`
      : payload.summary;
  if (!tail) return headline;
  if (tail.includes(headline)) return tail;
  return `${headline}\n\n${tail}`;
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
    super(ErrorCode.InternalError, buildWireMessage(payload), payload);
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
