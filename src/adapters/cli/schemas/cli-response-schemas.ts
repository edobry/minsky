/**
 * CLI Response Schemas and Formatters
 *
 * Standardized response formatting for CLI commands that builds on domain response patterns
 * from Tasks #322 and #329. Provides consistent JSON and human-readable output across all CLI commands.
 */
import { z } from "zod";
import {
  BaseSuccessResponseSchema,
  BaseErrorResponseSchema,
  BaseResponseSchema,
  createSuccessResponse,
  createErrorResponse,
  OutputFormat,
  Verbosity,
} from "../../../domain/schemas/common-schemas";
import { log } from "../../../utils/logger";

// ========================
// CLI-SPECIFIC RESPONSE SCHEMAS
// ========================

/**
 * CLI output metadata for enhanced responses
 */
export const CliOutputMetadataSchema = z.object({
  timestamp: z.string().datetime(),
  executionTime: z.number().optional(),
  command: z.string().optional(),
  format: z.enum(["json", "yaml", "table", "text"]).default("json"),
  verbosity: z.enum(["quiet", "normal", "verbose", "debug"]).default("normal"),
});

/**
 * CLI success response with enhanced metadata
 */
export const CliSuccessResponseSchema = BaseSuccessResponseSchema.extend({
  metadata: CliOutputMetadataSchema.optional(),
});

/**
 * CLI error response with enhanced metadata and formatting
 */
export const CliErrorResponseSchema = BaseErrorResponseSchema.extend({
  metadata: CliOutputMetadataSchema.optional(),
  exitCode: z.number().default(1),
  suggestions: z.array(z.string()).optional(),
});

/**
 * CLI response union schema
 */
export const CliResponseSchema = z.union([CliSuccessResponseSchema, CliErrorResponseSchema]);

// ========================
// CLI RESPONSE BUILDERS
// ========================

/**
 * Creates a standardized CLI success response with metadata
 */
export function createCliSuccessResponse<T extends Record<string, any>>(
  data: T,
  options?: {
    command?: string;
    format?: OutputFormat;
    verbosity?: Verbosity;
    includeTimestamp?: boolean;
    executionTime?: number;
  }
): z.infer<typeof CliSuccessResponseSchema> & T {
  const includeTimestamp = options?.includeTimestamp ?? true;
  const timestamp = new Date().toISOString();

  return {
    success: true as const,
    ...(includeTimestamp && { timestamp }),
    ...data,
    ...(options && {
      metadata: {
        timestamp,
        ...(options.executionTime && { executionTime: options.executionTime }),
        ...(options.command && { command: options.command }),
        format: options.format || "json",
        verbosity: options.verbosity || "normal",
      },
    }),
  };
}

/**
 * Creates a standardized CLI error response with metadata
 */
export function createCliErrorResponse(
  error: string,
  options?: {
    errorCode?: string;
    details?: Record<string, any>;
    command?: string;
    format?: OutputFormat;
    verbosity?: Verbosity;
    exitCode?: number;
    suggestions?: string[];
    includeTimestamp?: boolean;
  }
): z.infer<typeof CliErrorResponseSchema> {
  const includeTimestamp = options?.includeTimestamp ?? true;
  const timestamp = new Date().toISOString();

  return {
    success: false as const,
    error,
    ...(options?.errorCode && { errorCode: options.errorCode }),
    ...(options?.details && { details: options.details }),
    ...(includeTimestamp && { timestamp }),
    exitCode: options?.exitCode ?? 1,
    ...(options?.suggestions && { suggestions: options.suggestions }),
    ...(options && {
      metadata: {
        timestamp,
        ...(options.command && { command: options.command }),
        format: options.format || "json",
        verbosity: options.verbosity || "normal",
      },
    }),
  };
}

// ========================
// CLI OUTPUT FORMATTERS
// ========================

/**
 * Output formatter options
 */
export interface CliOutputOptions {
  format?: OutputFormat;
  verbosity?: Verbosity;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
}

/**
 * Determines the effective output format based on options
 */
export function getEffectiveOutputFormat(options: CliOutputOptions): OutputFormat {
  if (options.json) return "json";
  if (options.format) return options.format;
  return "text";
}

/**
 * Determines the effective verbosity level based on options
 */
export function getEffectiveVerbosity(options: CliOutputOptions): Verbosity {
  if (options.quiet) return "quiet";
  if (options.debug) return "debug";
  if (options.verbose) return "verbose";
  if (options.verbosity) return options.verbosity;
  return "normal";
}

/**
 * Generic CLI output formatter that handles both success and error responses
 */
export function formatCliOutput<T extends Record<string, any>>(
  response: T,
  options: CliOutputOptions,
  customFormatter?: (data: T, options: CliOutputOptions) => string
): void {
  const format = getEffectiveOutputFormat(options);
  const verbosity = getEffectiveVerbosity(options);

  // Handle JSON format
  if (format === "json") {
    log.cli(JSON.stringify(response, null, 2));
    return;
  }

  // Handle custom formatter
  if (customFormatter) {
    const output = customFormatter(response, { ...options, format, verbosity });
    log.cli(output);
    return;
  }

  // Handle error responses
  if ("success" in response && response.success === false) {
    formatCliError(response as any, options);
    return;
  }

  // Handle success responses
  if ("success" in response && response.success === true) {
    formatCliSuccess(response, options);
    return;
  }

  // Fallback to JSON for unknown response types
  log.cli(JSON.stringify(response, null, 2));
}

/**
 * Formats CLI success responses in human-readable format
 */
export function formatCliSuccess<T extends Record<string, any>>(
  response: T,
  options: CliOutputOptions
): void {
  const verbosity = getEffectiveVerbosity(options);

  if (verbosity === "quiet") {
    // In quiet mode, only output essential data
    if (response.result) {
      log.cli(String(response.result));
    }
    return;
  }

  // Show success indicator for normal+ verbosity
  log.cli("✅ Operation completed successfully");

  // Output main result data
  if (response.result || response.data) {
    const data = response.result || response.data;
    if (typeof data === "string") {
      log.cli(data);
    } else if (Array.isArray(data)) {
      formatArrayOutput(data, options);
    } else if (typeof data === "object") {
      formatObjectOutput(data, options);
    }
  }

  // Show metadata in verbose/debug mode
  if ((verbosity === "verbose" || verbosity === "debug") && response.metadata) {
    log.cli("");
    log.cli("📊 Metadata:");
    formatObjectOutput(response.metadata, { ...options, verbosity: "normal" });
  }

  // Show timestamp in debug mode
  if (verbosity === "debug" && response.timestamp) {
    log.cli("");
    log.cli(`🕒 Timestamp: ${response.timestamp}`);
  }
}

/**
 * Formats CLI error responses in human-readable format
 */
export function formatCliError(
  error: z.infer<typeof CliErrorResponseSchema>,
  options: CliOutputOptions
): void {
  const verbosity = getEffectiveVerbosity(options);

  // Always show the error message
  log.cliError(`❌ Error: ${error.error}`);

  // Show error code if available
  if (error.errorCode && verbosity !== "quiet") {
    log.cliError(`Code: ${error.errorCode}`);
  }

  // Show suggestions if available
  if (error.suggestions && error.suggestions.length > 0 && verbosity !== "quiet") {
    log.cliError("");
    log.cliError("💡 Suggestions:");
    error.suggestions.forEach((suggestion) => {
      log.cliError(`  • ${suggestion}`);
    });
  }

  // Show details in verbose/debug mode
  if ((verbosity === "verbose" || verbosity === "debug") && error.details) {
    log.cliError("");
    log.cliError("🔍 Details:");
    log.cliError(JSON.stringify(error.details, null, 2));
  }

  // Show metadata in debug mode
  if (verbosity === "debug" && error.metadata) {
    log.cliError("");
    log.cliError("📊 Metadata:");
    log.cliError(JSON.stringify(error.metadata, null, 2));
  }
}

/**
 * Formats array output in human-readable format
 */
export function formatArrayOutput(data: any[], options: CliOutputOptions): void {
  const verbosity = getEffectiveVerbosity(options);

  if (data.length === 0) {
    if (verbosity !== "quiet") {
      log.cli("(no items)");
    }
    return;
  }

  // For simple arrays, show as list
  if (data.every((item) => typeof item === "string" || typeof item === "number")) {
    data.forEach((item, index) => {
      if (verbosity === "quiet") {
        log.cli(String(item));
      } else {
        log.cli(`${index + 1}. ${item}`);
      }
    });
    return;
  }

  // For object arrays, show as structured output
  data.forEach((item, index) => {
    if (verbosity !== "quiet") {
      log.cli(`\n--- Item ${index + 1} ---`);
    }
    formatObjectOutput(item, options);
  });
}

/**
 * Formats object output in human-readable format
 */
export function formatObjectOutput(data: Record<string, any>, options: CliOutputOptions): void {
  const verbosity = getEffectiveVerbosity(options);

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      if (verbosity !== "quiet") {
        log.cli(`${key}: (not set)`);
      }
      continue;
    }

    if (typeof value === "object") {
      if (verbosity !== "quiet") {
        log.cli(`${key}:`);
        log.cli(
          JSON.stringify(value, null, 2)
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")
        );
      }
    } else {
      log.cli(`${key}: ${value}`);
    }
  }
}

// ========================
// SPECIALIZED FORMATTERS
// ========================

/**
 * Formats task list output
 */
export function formatTaskListOutput(tasks: any[], options: CliOutputOptions): string {
  const verbosity = getEffectiveVerbosity(options);

  if (tasks.length === 0) {
    return verbosity === "quiet" ? "" : "No tasks found.";
  }

  if (verbosity === "quiet") {
    return tasks.map((task) => task.id || task.taskId).join("\n");
  }

  let output = `Found ${tasks.length} task${tasks.length !== 1 ? "s" : ""}\n\n`;

  tasks.forEach((task) => {
    const id = task.id || task.taskId;
    const title = task.title || "(no title)";
    const status = task.status || "UNKNOWN";

    output += `📋 ${id}: ${title}\n`;
    output += `   Status: ${status}\n`;

    if (verbosity === "verbose" || verbosity === "debug") {
      if (task.description) {
        output += `   Description: ${task.description.substring(0, 100)}${task.description.length > 100 ? "..." : ""}\n`;
      }
      if (task.createdAt) {
        output += `   Created: ${task.createdAt}\n`;
      }
    }

    output += "\n";
  });

  return output.trim();
}

/**
 * Formats session list output
 */
export function formatSessionListOutput(sessions: any[], options: CliOutputOptions): string {
  const verbosity = getEffectiveVerbosity(options);

  if (sessions.length === 0) {
    return verbosity === "quiet" ? "" : "No sessions found.";
  }

  if (verbosity === "quiet") {
    return sessions.map((session) => session.name || session.id).join("\n");
  }

  let output = `Found ${sessions.length} session${sessions.length !== 1 ? "s" : ""}\n\n`;

  sessions.forEach((session) => {
    const name = session.name || session.id;
    const status = session.status || "UNKNOWN";
    const taskId = session.taskId ? ` (Task: ${session.taskId})` : "";

    output += `🚀 ${name}${taskId}\n`;
    output += `   Status: ${status}\n`;

    if (verbosity === "verbose" || verbosity === "debug") {
      if (session.branch) {
        output += `   Branch: ${session.branch}\n`;
      }
      if (session.workspacePath) {
        output += `   Workspace: ${session.workspacePath}\n`;
      }
      if (session.createdAt) {
        output += `   Created: ${session.createdAt}\n`;
      }
    }

    output += "\n";
  });

  return output.trim();
}

// ========================
// TYPE EXPORTS
// ========================

export type CliOutputMetadata = z.infer<typeof CliOutputMetadataSchema>;
export type CliSuccessResponse = z.infer<typeof CliSuccessResponseSchema>;
export type CliErrorResponse = z.infer<typeof CliErrorResponseSchema>;
export type CliResponse = z.infer<typeof CliResponseSchema>;
