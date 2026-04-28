/**
 * Canonical list of structured MCP error codes.
 *
 * When an MCP tool handler fails with a structured error, the `code` field
 * in `error.data` will be one of these values. External agents can branch on
 * `error.data.code` rather than regex-parsing `error.message`.
 *
 * Add new codes here (alphabetized) as additional handlers adopt structured
 * errors.
 */
export const McpErrorCode = {
  /** A git merge conflict prevented the operation from completing. */
  CONFLICT: "CONFLICT",
  /** A pre-commit hook blocked the commit. `subprocessOutput` contains the hook stderr. */
  PRE_COMMIT_FAILED: "PRE_COMMIT_FAILED",
  /** A subprocess invoked during the operation exited with a non-zero status. */
  SUBPROCESS_FAILED: "SUBPROCESS_FAILED",
  /** Input parameters failed validation. */
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

/** Union type of all valid MCP error code strings. */
export type McpErrorCodeValue = (typeof McpErrorCode)[keyof typeof McpErrorCode];
