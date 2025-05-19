#!/usr/bin/env bun
import winston, { format, transports } from "winston";
import type { TransformableInfo } from "logform";

// Environment variable for log level
// Set default to "info" - explicit LOG_LEVEL="debug" is required for debug logs
const logLevel = process.env.LOG_LEVEL || "info";

// Environment variable for log mode
// STRUCTURED: Full JSON logs for machine consumption (for CI/CD, integrations)
// HUMAN: Clean, human-readable logs only (default for CLI usage)
export enum LogMode {
  STRUCTURED = "STRUCTURED",
  HUMAN = "HUMAN",
}

/**
 * Determine the current logging mode
 *
 * Default behavior:
 * - HUMAN mode when running in a terminal
 * - STRUCTURED mode otherwise (CI/CD, scripts)
 *
 * Can be explicitly set via MINSKY_LOG_MODE environment variable
 */
export function getLogMode(): LogMode {
  const envMode = process.env.MINSKY_LOG_MODE?.toUpperCase();

  // If explicitly set via environment variable, respect that
  if (envMode === LogMode.STRUCTURED) {
    return LogMode.STRUCTURED;
  }

  if (envMode === LogMode.HUMAN) {
    return LogMode.HUMAN;
  }

  // Auto-detect based on terminal environment
  const isTTY = process.stdout.isTTY;
  return isTTY ? LogMode.HUMAN : LogMode.STRUCTURED;
}

// Get current log mode
const currentLogMode = getLogMode();

// Flag to explicitly enable agent logs in HUMAN mode
const enableAgentLogs = process.env.ENABLE_AGENT_LOGS === "true";

// Common format for agent logs (JSON)
const agentLogFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }), // Log stack traces
  format.json()
);

// Common format for program/CLI logs (plain text)
const programLogFormat = format.combine(
  format.colorize(),
  format.printf((info: TransformableInfo) => {
    // Ensure message is a string
    const message = typeof info.message === "string" ? info.message : JSON.stringify(info.message);
    // For user-facing CLI output, just show the message without timestamp and log level
    let log = message;
    if (info.stack) {
      log += `\n${info.stack}`;
    }
    // Add other metadata if it exists
    const metadata = Object.keys(info).reduce(
      (acc, key) => {
        if (["level", "message", "timestamp", "stack"].includes(key)) {
          return acc;
        }
        acc[key] = info[key];
        return acc;
      },
      {} as Record<string, any>
    );

    if (Object.keys(metadata).length > 0) {
      try {
        log += ` ${JSON.stringify(metadata)}`;
      } catch (e) {
        // ignore serialization errors for metadata in text logs
      }
    }
    return log;
  })
);

// Agent logger: structured JSON to stdout (when enabled)
const agentLogger = winston.createLogger({
  level: logLevel,
  format: agentLogFormat,
  transports: [],
  exitOnError: false,
});

// Only add stdout transport if in STRUCTURED mode or explicitly enabled in HUMAN mode
if (currentLogMode === LogMode.STRUCTURED || enableAgentLogs) {
  agentLogger.add(new transports.Console({ stderrLevels: [] })); // Ensure only stdout
  agentLogger.exceptions.handle(
    new transports.Console({ format: agentLogFormat, stderrLevels: [] })
  );
  agentLogger.rejections.handle(
    new transports.Console({ format: agentLogFormat, stderrLevels: [] })
  );
}

// Program logger: plain text to stderr
const programLogger = winston.createLogger({
  level: logLevel,
  format: programLogFormat,
  transports: [
    new transports.Console({
      stderrLevels: ["error", "warn", "info", "http", "verbose", "debug", "silly"],
    }),
  ], // Ensure only stderr
  exitOnError: false,
});

// Always setup exception handlers for programLogger
programLogger.exceptions.handle(new transports.Console({ format: programLogFormat }));
programLogger.rejections.handle(new transports.Console({ format: programLogFormat }));

interface LogContext {
  [key: string]: any;
}

// Check if we're in structured mode
export const isStructuredMode = () => currentLogMode === LogMode.STRUCTURED;
// Check if we're in human mode
export const isHumanMode = () => currentLogMode === LogMode.HUMAN;

// Convenience wrapper
export const log = {
  // Agent logs (structured JSON to stdout)
  agent: (message: string, context?: LogContext) => agentLogger.info(message, context),
  debug: (message: string, context?: LogContext) => agentLogger.debug(message, context),
  warn: (message: string, context?: LogContext) => agentLogger.warn(message, context),
  error: (
    message: string,
    context?: LogContext | Error | { originalError?: any; stack?: string; [key: string]: any }
  ) => {
    if (context instanceof Error) {
      agentLogger.error(message, {
        originalError: context.message,
        stack: context.stack,
        name: context.name,
      });
    } else if (
      typeof context === "object" &&
      context !== null &&
      (context.originalError || context.stack)
    ) {
      agentLogger.error(message, context);
    } else {
      agentLogger.error(message, context);
    }
  },
  // Program/CLI logs (plain text to stderr)
  cli: (message: string, ...args: any[]) => programLogger.info(message, ...args),
  cliWarn: (message: string, ...args: any[]) => programLogger.warn(message, ...args),
  cliError: (message: string, ...args: any[]) => programLogger.error(message, ...args),
  // Add ability to set log level
  setLevel: (level: string) => {
    agentLogger.level = level;
    programLogger.level = level;
  },
  // Add additional CLI-oriented debug log
  cliDebug: (message: string, ...args: any[]) => programLogger.debug(message, ...args),
  // Expose log mode information
  mode: currentLogMode,
  isStructuredMode,
  isHumanMode,
};

// Ensure logs are written before exiting on unhandled exceptions/rejections
const handleExit = async (error?: Error) => {
  if (error) {
    // Use programLogger for unhandled errors that might crash the CLI
    programLogger.error("Unhandled error or rejection, exiting.", error);
  }
  // Give logs a moment to flush
  await new Promise((resolve) => setTimeout(resolve, 100));
};

process.on("uncaughtException", async (error) => {
  await handleExit(error);
  process.exit(1);
});

process.on("unhandledRejection", async (reason, promise) => {
  await handleExit(reason instanceof Error ? reason : new Error(String(reason)));
  process.exit(1);
});

// Basic test to ensure it works - can be removed or moved to a test file
if (process.env.RUN_LOGGER_TEST === "true") {
  console.log("--- Agent Logger (stdout) ---");
  log.debug("Agent debug message", { data: "some debug data" });
  log.agent("Agent info message", { user: "test" });
  log.warn("Agent warning message", { code: 100 });
  log.error("Agent error message (string)", { details: "string error" });
  log.error("Agent error via Error object", new Error("Test error"));

  console.log("\n--- Program Logger (stderr) ---");
  log.cliDebug("This is a CLI debug message.");
  log.cli("This is a CLI message.");
  log.cliWarn("This is a CLI warning.");
  log.cliError("This is a CLI error.");

  console.log("\n--- Environment Information ---");
  console.log(`Current Log Mode: ${log.mode}`);
  console.log(`Is Structured Mode: ${log.isStructuredMode()}`);
  console.log(`Is Human Mode: ${log.isHumanMode()}`);
  console.log(`Is Terminal (TTY): ${Boolean(process.stdout.isTTY)}`);
}
