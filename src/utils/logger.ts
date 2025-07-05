#!/usr/bin/env bun
import * as winston from "winston";
const { format, transports } = winston;
import type {} from "logform";

// Environment variable for log level
// Set default to "info" - explicit LOG_LEVEL="debug" is required for debug logs
const logLevel = (process.env as any).LOGLEVEL || "info";

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
  const envMode = (process.env.MINSKY_LOG_MODE as any).toUpperCase();

  // If explicitly set via environment variable, respect that
  if (envMode === (LogMode as any).STRUCTURED) {
    return (LogMode as any).STRUCTURED;
  }

  if (envMode === (LogMode as any).HUMAN) {
    return (LogMode as any).HUMAN;
  }

  // Auto-detect based on terminal environment
  const isTTY = (process.stdout as any).isTTY;
  return isTTY ? (LogMode as any).HUMAN : (LogMode as any).STRUCTURED;
}

// Get current log mode
const currentLogMode = getLogMode();

// Flag to explicitly enable agent logs in HUMAN mode
const enableAgentLogs = (process.env as any).ENABLE_AGENT_LOGS === "true";

// Common format for agent logs (JSON)
const agentLogFormat = format.combine(
  (format as any).timestamp(),
  format.errors({ stack: true }), // Log stack traces
  format.json()
);

// Common format for program/CLI logs (plain text)
const programLogFormat = format.combine(
  format.colorize(),
  format.printf((info: any) => {
    // Cast info to a proper type
    const logInfo = info as { message?: any; stack?: string; [key: string]: any };
    // Ensure message is a string
    const message =
      typeof (logInfo as any).message === "string" ? (logInfo as any).message : JSON.stringify((logInfo as any).message);
    // For user-facing CLI output, just show the message without timestamp and log level
    let log = message;
    if (logInfo.stack) {
      log += `\n${logInfo.stack}`;
    }
    // Add other metadata if it exists
    const metadata = (Object.keys(logInfo) as any).reduce(
      (acc, key) => {
        if ((["level", "message", "timestamp", "stack"] as any).includes(key)) {
          return acc;
        }
        acc[key] = logInfo[key];
        return acc;
      },
      {} as Record<string, any>
    );

    if ((Object as any).keys(metadata as any).length > 0) {
      try {
        log += ` ${JSON.stringify(metadata as any)}`;
      } catch (error) {
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
if (currentLogMode === (LogMode as any).STRUCTURED || enableAgentLogs) {
  (agentLogger as any).add(new transports.Console({ stderrLevels: [] })); // Ensure only stdout
  (agentLogger.exceptions as any).handle(
    new transports.Console({ format: agentLogFormat, stderrLevels: [] })
  );
  (agentLogger.rejections as any).handle(
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
(programLogger.exceptions as any).handle(new transports.Console({ format: programLogFormat }));
(programLogger.rejections as any).handle(new transports.Console({ format: programLogFormat }));

interface LogContext {
  [key: string]: any;
}

// Check if we're in structured mode
export const isStructuredMode = () => currentLogMode === (LogMode as any).STRUCTURED;
// Check if we're in human mode
export const isHumanMode = () => currentLogMode === (LogMode as any).HUMAN;

// Convenience wrapper
export const log = {
  // Agent logs (structured JSON to stdout)
  agent: (message: any) => {
    // Only log to agentLogger if we're in STRUCTURED mode or agent logs are explicitly enabled
    if (currentLogMode === (LogMode as any).HUMAN && !enableAgentLogs) {
      return;
    }
    (agentLogger as any).info(message);
  },
  debug: (message: string, context?: LogContext) => {
    // In HUMAN mode (for CLI), suppress debug logs unless explicitly enabled
    if (currentLogMode === (LogMode as any).HUMAN && !enableAgentLogs) {
      // No-op in HUMAN mode to prevent "no transports" warning
      return;
    }
    // Otherwise, use agentLogger as normal
    if (context) {
      (agentLogger as any).debug(message, context as any);
    } else {
      (agentLogger as any).debug(message);
    }
  },
  info: (message: string, context?: LogContext) => {
    // Only log to agentLogger if we're in STRUCTURED mode or agent logs are explicitly enabled
    if (currentLogMode === (LogMode as any).HUMAN && !enableAgentLogs) {
      return;
    }
    if (context) {
      (agentLogger as any).info(message, context as any);
    } else {
      (agentLogger as any).info(message);
    }
  },
  warn: (message: string, context?: LogContext) => {
    // Only log to agentLogger if we're in STRUCTURED mode or agent logs are explicitly enabled
    if (currentLogMode === (LogMode as any).HUMAN && !enableAgentLogs) {
      return;
    }
    if (context) {
      (agentLogger as any).warn(message, context as any);
    } else {
      (agentLogger as any).warn(message);
    }
  },
  error: (
    message: string,
    context?:
      | LogContext
      | Error
      | { originalError?: any; stack?: string; [key: string]: any }
  ) => {
    // For errors, in HUMAN mode route to programLogger.error instead of suppressing
    if (currentLogMode === (LogMode as any).HUMAN && !enableAgentLogs) {
      // Format the error for the programLogger
      if (context instanceof Error) {
        (programLogger as any).error(`${message}: ${(context as any).message}`);
        if ((context as any).stack) {
          (programLogger as any).error((context as any).stack);
        }
      } else if (
        typeof context === "object" &&
        context !== null &&
        ((context as any).originalError || (context as any).stack)
      ) {
        (programLogger as any).error(`${message}: ${(context as any).originalError || JSON.stringify(context as any)}`);
        if ((context as any).stack) {
          (programLogger as any).error((context as any).stack);
        }
      } else {
        (programLogger as any).error(message, context as any);
      }
      return;
    }

    // In STRUCTURED mode or if agent logs explicitly enabled, use agentLogger
    if (context instanceof Error) {
      (agentLogger as any).error(message, {
        originalError: (context as any).message,
        stack: (context as any).stack,
        name: (context as any).name,
      });
    } else if (
      typeof context === "object" &&
      context !== null &&
      ((context as any).originalError || (context as any).stack)
    ) {
      (agentLogger as any).error(message, context as any);
    } else {
      (agentLogger as any).error(message, context as any);
    }
  },
  // Program/CLI logs (plain text to stderr)
  cli: (message: any) => (programLogger as any).info(String(message)),
  cliWarn: (message: any) => (programLogger as any).warn(String(message)),
  cliError: (message: any) => (programLogger as any).error(String(message)),
  // Add ability to set log level
  setLevel: (level: string) => {
    (agentLogger as any).level = level;
    (programLogger as any).level = level;
  },
  // Add additional CLI-oriented debug log
  cliDebug: (message: any) => (programLogger as any).debug(String(message)),
  // Add system-level debug logging that always goes to stderr, bypassing the mode limitations
  // Use this for important system debugging that should always be visible when debug level is set
  systemDebug: (message: any) => {
    // Always log to programLogger (stderr) regardless of mode
    (programLogger as any).debug(String(message));
  },
  // Expose log mode information
  mode: currentLogMode,
  isStructuredMode,
  isHumanMode,
};

// Ensure logs are written before exiting on unhandled exceptions/rejections
const handleExit = async (error?: Error) => {
  if (error) {
    // Use programLogger for unhandled errors that might crash the CLI
    (programLogger as any).error("Unhandled error or rejection, exiting.", error as any);
  }
  // Give logs a moment to flush
  await new Promise((resolve) => setTimeout(resolve, 100));
};

// Basic test to ensure it works - can be removed or moved to a test file
if ((process.env as any).RUN_LOGGER_TEST === "true") {
  log.cli("--- Agent Logger (stdout) ---");
  log.debug("Agent debug message");
  log.agent("Agent info message");
  log.warn("Agent warning message");
  log.error("Agent error message (string)", { details: "string error" });
  log.error("Agent error via Error object", new Error("Test error"));

  log.cli("\n--- Program Logger (stderr) ---");
  log.cliDebug("This is a CLI debug message.");
  log.cli("This is a CLI message.");
  log.cliWarn("This is a CLI warning.");
  log.cliError("This is a CLI error.");
  log.systemDebug("This is a system debug message that works in all modes.");

  log.cli("\n--- Environment Information ---");
  log.cli(`Current Log Mode: ${log.mode}`);
  log.cli(`Is Structured Mode: ${log.isStructuredMode()}`);
  log.cli(`Is Human Mode: ${log.isHumanMode()}`);
  log.cli(`Is Terminal (TTY): ${Boolean((process.stdout as any).isTTY)}`);
}
