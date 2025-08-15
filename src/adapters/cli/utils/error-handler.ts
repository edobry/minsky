/**
 * CLI error handling utilities
 *
 * This module provides centralized error handling for CLI commands to ensure
 * consistent, user-friendly error messages while supporting detailed logging
 * for debugging purposes.
 */
import {
  MinskyError,
  ValidationError,
  ResourceNotFoundError,
  ServiceUnavailableError,
  FileSystemError,
  ConfigurationError,
  GitOperationError,
  ensureError,
} from "../../../errors/index";
import { ZodError } from "zod";
import { log, isStructuredMode } from "../../../utils/logger";
import { exit } from "../../../utils/process";
/**
 * Determines if debug mode is enabled based on environment variables
 */
export const isDebugMode = (): boolean =>
  process.env.DEBUG === "true" ||
  process.env.DEBUG === "1" ||
  (typeof process.env.NODE_DEBUG === "string" && process.env.NODE_DEBUG.includes("minsky"));

/**
 * Handles CLI command errors with consistent formatting
 *
 * - Provides concise, user-friendly error messages
 * - Shows detailed error information only in debug mode
 * - Format messages differently based on error type and environment
 *
 * @param error Any error caught during command execution
 */
export function handleCliError(error: any): never {
  const normalizedError = ensureError(error as any);

  // In human mode, use programLogger for all user-facing errors
  // In structured mode, use both loggers as configured

  // Sanitize and enrich database error messages (e.g., Drizzle "Failed query: ...")
  const sanitizeMessage = (msg: string): string => {
    if (!msg) return msg;

    // Detect Drizzle-style error strings and extract useful parts
    if (msg.includes("Failed query")) {
      const showFull = isDebugMode() || process.env.MINSKY_SHOW_SQL === "true";

      // Extract the failed query block and primary error message when possible
      const failedQueryMatch = msg.match(/Failed query:[\s\S]*?(?=(\nError:|\nparams:|$))/i);
      const errorLineMatch = msg.match(/\n(Error:[\s\S]*$)/i);
      const paramsMatch = msg.match(/\nparams:[\s\S]*$/i);

      const failedQueryBlock = failedQueryMatch ? failedQueryMatch[0] : "";
      const errorLine = errorLineMatch ? errorLineMatch[1].trim() : "Database error";
      const paramsBlock = paramsMatch ? paramsMatch[0].trim() : "";

      // Pull the complete SQL statement after "Failed query:"
      let sqlSnippet = "";
      if (failedQueryBlock) {
        const lines = failedQueryBlock.split("\n");
        // Get all non-empty lines after the label and join them
        const sqlLines = lines
          .slice(1)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        sqlSnippet = sqlLines.join(" ").trim();
      }

      if (showFull) {
        // In debug/full mode, include the entire failed query block for maximum context
        const details: string[] = [];
        if (errorLine) details.push(errorLine);
        if (failedQueryBlock) details.push(failedQueryBlock.trim());
        if (paramsBlock && !/^params:\s*$/i.test(paramsBlock)) details.push(paramsBlock);
        return details.join("\n");
      }

      // In normal mode, provide a concise but actionable message
      const maxSqlLength = 80;
      const compactSql =
        sqlSnippet.length > maxSqlLength ? `${sqlSnippet.slice(0, maxSqlLength)}...` : sqlSnippet;
      const compactError = (errorLine.split("\n")[0] || errorLine).slice(0, 200);
      const parts = [
        `Database operation failed: ${compactError}`.trim(),
        compactSql ? `Query: ${compactSql}` : "",
        sqlSnippet.length > maxSqlLength
          ? "(use --show-sql for full SQL)"
          : "(use --show-sql or --debug for full SQL, error cause, and params)",
      ].filter(Boolean);
      return parts.join("\n");
    }

    // Default: Only the first line to avoid verbose stacks in CLI output
    return (msg.split("\n")[0] || msg).slice(0, 200);
  };

  // Format error message based on type
  if (error instanceof ValidationError) {
    // Check if the error message already has good formatting (starts with emoji)
    const message = normalizedError.message;
    const hasGoodFormatting = /^[❌🚫⛔💥]/u.test(message);

    if (hasGoodFormatting) {
      // Already well-formatted, display as-is
      log.cliError(message);
    } else {
      // Add validation error prefix for less formatted messages
      log.cliError(`Validation error: ${sanitizeMessage(message)}`);
    }

    // Show validation details in debug mode
    if (isDebugMode() && (error as any).errors) {
      log.cliError("\nValidation details:");
      log.cliError(JSON.stringify((error as any).errors, undefined, 2));
    }
  } else if (error instanceof ZodError) {
    // Zod validation errors (e.g., bad CLI parameter values)
    // Show the most relevant issue message and hint about expected format
    const firstIssue = (error as ZodError).issues?.[0];
    const issueMessage = firstIssue?.message || normalizedError.message || "Invalid input";
    const issuePath =
      Array.isArray(firstIssue?.path) && firstIssue!.path.length > 0
        ? ` (field: ${firstIssue!.path.join(".")})`
        : "";

    log.cliError(`Validation error: ${issueMessage}${issuePath}`);

    // Show full issue details in debug mode
    if (isDebugMode()) {
      log.cliError("\nValidation details:");
      log.cliError(JSON.stringify((error as ZodError).issues, undefined, 2));
    }
  } else if (error instanceof ResourceNotFoundError) {
    log.cliError(`Not found: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).resourceType && (error as any).resourceId) {
      log.cliError(`Resource: ${(error as any).resourceType}, ID: ${(error as any).resourceId}`);
    }
  } else if (error instanceof ServiceUnavailableError) {
    log.cliError(`Service unavailable: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).serviceName) {
      log.cliError(`Service: ${(error as any).serviceName}`);
    }
  } else if (error instanceof FileSystemError) {
    log.cliError(`File system error: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).path) {
      log.cliError(`Path: ${(error as any).path}`);
    }
  } else if (error instanceof ConfigurationError) {
    log.cliError(`Configuration error: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).configKey) {
      log.cliError(`Key: ${(error as any).configKey}`);
    }
  } else if (error instanceof GitOperationError) {
    log.cliError(`Git operation failed: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).command) {
      log.cliError(`Command: ${(error as any).command}`);
    }
  } else if (isLikelyPostgresError(error)) {
    const anyErr: any = error as any;
    const code = anyErr?.code || anyErr?.originalError?.code || anyErr?.cause?.code;
    const rawMessage =
      anyErr?.message || anyErr?.originalError?.message || String(normalizedError.message);
    const detail = anyErr?.detail || anyErr?.originalError?.detail || anyErr?.cause?.detail;
    const hint = anyErr?.hint || anyErr?.originalError?.hint || anyErr?.cause?.hint;
    const schema = anyErr?.schema || anyErr?.originalError?.schema || anyErr?.cause?.schema;
    const table = anyErr?.table || anyErr?.originalError?.table || anyErr?.cause?.table;
    const constraint =
      anyErr?.constraint || anyErr?.originalError?.constraint || anyErr?.cause?.constraint;

    // Extract concise driver error message from Drizzle-wrapped text (strip query/params blocks)
    const drizzleMsg: string =
      typeof rawMessage === "string" ? rawMessage : String(rawMessage || "");
    let conciseDriverMessage = drizzleMsg;
    // Prefer the text after an explicit "Error:" if present
    const errorOnlyMatch = drizzleMsg.match(/\nError:\s*([\s\S]*?)(?=(\nparams:|$))/i);
    if (errorOnlyMatch && errorOnlyMatch[1]) {
      conciseDriverMessage = errorOnlyMatch[1].trim();
    } else if (/^Failed query:/i.test(drizzleMsg)) {
      // Remove the failed query and params blocks
      conciseDriverMessage = drizzleMsg
        .replace(/Failed query:[\s\S]*?(?=(\nError:|\nparams:|$))/i, "")
        .replace(/\nparams:[\s\S]*$/i, "")
        .replace(/^Error:\s*/i, "")
        .trim();
    }

    // Try to extract failed SQL snippet from drizzle-wrapped message
    const showFull = isDebugMode() || process.env.MINSKY_SHOW_SQL === "true";
    const msgForQuery: string =
      typeof normalizedError.message === "string"
        ? normalizedError.message
        : String(normalizedError.message);
    const failedQueryMatch = msgForQuery.match(/Failed query:[\s\S]*?(?=(\nError:|\nparams:|$))/i);
    const failedQueryBlock = failedQueryMatch ? failedQueryMatch[0] : "";
    let sqlSnippet = "";
    if (failedQueryBlock) {
      // Extract the complete SQL statement, not just the first line
      const lines = failedQueryBlock
        .split("\n")
        .slice(1) // Skip "Failed query:" line
        .map((l) => l.trim())
        .filter((l) => l.length > 0); // Remove empty lines
      sqlSnippet = lines.join(" ").trim();
    }

    // Try to derive table name from the failed SQL if driver didn't provide it
    let tableNameFromQuery: string | undefined;
    if (failedQueryBlock) {
      const m1 = failedQueryBlock.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"\.)?"([^"]+)"/i
      );
      if (m1 && m1[1]) {
        tableNameFromQuery = m1[1];
      }
    }

    // Compose a clean, high-signal output
    const lines: string[] = [];
    // Ensure we always have a non-empty driver message
    let headerMessage = conciseDriverMessage;
    if (!headerMessage || headerMessage.length === 0) {
      if (code === "42P07") {
        headerMessage = tableNameFromQuery
          ? `relation "${tableNameFromQuery}" already exists`
          : "relation already exists";
      } else {
        headerMessage = "database operation failed";
      }
    }
    const header = code
      ? `❌ Database error (${code}): ${headerMessage}`
      : `❌ Database error: ${headerMessage}`;
    lines.push(header);
    if (schema) lines.push(`schema: ${schema}`);
    const effectiveTable = table || tableNameFromQuery;
    if (effectiveTable) lines.push(`table: ${effectiveTable}`);
    if (constraint) lines.push(`constraint: ${constraint}`);
    if (detail) lines.push(`detail: ${detail}`);
    if (hint) lines.push(`hint: ${hint}`);
    if (sqlSnippet && !showFull) {
      // Show a concise, readable snippet for non-verbose mode
      const maxLength = 80;
      const snippet =
        sqlSnippet.length > maxLength ? `${sqlSnippet.slice(0, maxLength)}...` : sqlSnippet;
      lines.push(`query: ${snippet}`);
      if (sqlSnippet.length > maxLength) {
        lines.push("(use --show-sql for full SQL)");
      }
    }
    if (!sqlSnippet && !showFull) {
      lines.push("(use --show-sql or --debug for full failed SQL)");
    }
    log.cliError(lines.join("\n"));
  } else {
    log.cliError(`❌ ${sanitizeMessage(normalizedError.message)}`);
  }

  // Show detailed debug information only in debug mode
  if (isDebugMode()) {
    log.cliError("\nDebug information:");
    if (normalizedError.stack) {
      log.cliError(normalizedError.stack);
    }

    // Log cause chain if available
    if (normalizedError instanceof MinskyError && normalizedError.cause) {
      log.cliError("\nCaused by:");
      const cause = normalizedError.cause;
      if (cause instanceof Error) {
        log.cliError(cause.stack || cause.message);
      } else {
        log.cliError(String(cause));
      }
    }
  }

  // Avoid JSON blob in CLI: emit structured logs only in debug mode
  if (isStructuredMode() && isDebugMode()) {
    const conciseMsg = sanitizeMessage(normalizedError.message);
    log.error("CLI operation failed", { message: conciseMsg });
  }

  exit(1);
}

/**
 * Map common PostgreSQL SQLSTATE codes to human-friendly names
 * Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
function isLikelyPostgresError(err: unknown): boolean {
  const e: any = err as any;
  return Boolean(
    (e && typeof e === "object" && (e.code || e.severity || e.schema || e.table)) ||
      (e?.originalError && (e.originalError.code || e.originalError.severity)) ||
      (e?.cause && (e.cause.code || e.cause.severity))
  );
}

/**
 * Helper function for CLI commands that output results as JSON or formatted text
 *
 * @param result The result to output
 * @param options Output options
 */
export function outputResult<T>(
  result: T,
  options: { json?: boolean; formatter?: (result: any) => void }
): void {
  if (options.json) {
    // For JSON output, use agent logger to ensure it goes to stdout
    // This ensures machine-readable output is separated from human-readable messages
    if (isStructuredMode()) {
      // In structured mode, log to agent logger
      log.agent({ message: "Command result", result });
    } else {
      // In human mode or when json is explicitly requested, write directly to stdout
      log.cli(JSON.stringify(result, undefined, 2));
    }
  } else if (options.formatter) {
    options.formatter(result);
  } else {
    log.cli(String(result));
  }
}
