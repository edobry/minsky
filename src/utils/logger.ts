#!/usr/bin/env bun
import * as winston from "winston";
const { format, transports } = winston;
import type {} from "logform";
import config from "config";

// Logger configuration interface
interface LoggerConfig {
  mode: "HUMAN" | "STRUCTURED" | "auto";
  level: "debug" | "info" | "warn" | "error";
  enableAgentLogs: boolean;
}

// Log context interface
export interface LogContext {
  [key: string]: any;
}

// Environment variable for log mode
// STRUCTURED: Full JSON logs for machine consumption (for CI/CD, integrations)
// HUMAN: Clean, human-readable logs only (default for CLI usage)
export enum LogMode {
  STRUCTURED = "STRUCTURED",
  HUMAN = "HUMAN",
}

/**
 * Get logger configuration from environment variables first, then config system
 * This prevents early initialization of node-config which can cause warnings
 */
function getLoggerConfig(): LoggerConfig {
  // First try environment variables to avoid early node-config initialization
  const envMode = process.env.MINSKY_LOG_MODE || null;
  const envLevel = process.env.LOGLEVEL || null;
  const envAgentLogs = (process.env.ENABLE_AGENT_LOGS as unknown) === "true";

  // If we have all config from environment, use it
  if (envMode && envLevel) {
    return {
      mode: envMode as "HUMAN" | "STRUCTURED" | "auto",
      level: envLevel as "debug" | "info" | "warn" | "error",
      enableAgentLogs: envAgentLogs,
    };
  }

  // Otherwise try config system with fallback to environment/defaults
  let loggerConfig: LoggerConfig;

  try {
    // Try to get configuration from the config system
    const configMode = config.has("logger.mode") ? config.get("logger.mode") : null;
    const configLevel = config.has("logger.level") ? config.get("logger.level") : null;
    const configAgentLogs = config.has("logger.enableAgentLogs") ? config.get("logger.enableAgentLogs") : null;

    loggerConfig = {
      mode: (typeof configMode === "string" ? configMode : envMode || "auto") as "HUMAN" | "STRUCTURED" | "auto",
      level: (typeof configLevel === "string" ? configLevel : envLevel || "info") as "debug" | "info" | "warn" | "error",
      enableAgentLogs: typeof configAgentLogs === "boolean" ? configAgentLogs : envAgentLogs,
    };
  } catch (error) {
    // Fallback to environment variables if config system is unavailable
    // This ensures the logger works even during early initialization
    loggerConfig = {
      mode: (envMode || "auto") as "HUMAN" | "STRUCTURED" | "auto",
      level: (envLevel || "info") as "debug" | "info" | "warn" | "error",
      enableAgentLogs: envAgentLogs,
    };
  }

  return loggerConfig;
}

/**
 * Determine the current logging mode based on configuration
 *
 * Default behavior:
 * - HUMAN mode when running in a terminal
 * - STRUCTURED mode otherwise (CI/CD, scripts)
 *
 * Can be explicitly set via configuration or MINSKY_LOG_MODE environment variable
 */
export function getLogMode(configOverride?: LoggerConfig): LogMode {
  const config = configOverride || getLoggerConfig();

  // If explicitly set via configuration, respect that
  if (config.mode === "STRUCTURED") {
    return LogMode.STRUCTURED;
  }

  if (config.mode === "HUMAN") {
    return LogMode.HUMAN;
  }

  // Auto-detect based on terminal environment
  const isTTY = process.stdout.isTTY;
  return isTTY ? LogMode.HUMAN : LogMode.STRUCTURED;
}

/**
 * Create a logger instance with the given configuration
 * This allows for dependency injection and testing
 */
export function createLogger(configOverride?: LoggerConfig) {
  const loggerConfig = configOverride || getLoggerConfig();
  const logLevel = loggerConfig.level;
  const currentLogMode = getLogMode(loggerConfig);
  const enableAgentLogs = loggerConfig.enableAgentLogs;

  // Common format for agent logs (JSON)
  const agentLogFormat = format.combine(
    format.timestamp(),
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
        typeof logInfo.message === "string"
          ? logInfo.message
          : JSON.stringify(logInfo.message);
      // For user-facing CLI output, just show the message without timestamp and log level
      let log = message;
      if (logInfo.stack) {
        log += `\n${logInfo.stack}`;
      }
      // Add other metadata if it exists
      const metadata = Object.keys(logInfo).reduce(
        (acc, key) => {
          if (["level", "message", "timestamp", "stack"].includes(key)) {
            return acc;
          }
          acc[key] = logInfo[key];
          return acc;
        },
        {} as Record<string, any>
      );

      if (Object.keys(metadata).length > 0) {
        try {
          log += ` ${JSON.stringify(metadata as unknown)}`;
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

  // Check if we're in structured mode
  const isStructuredMode = () => currentLogMode === LogMode.STRUCTURED;
  // Check if we're in human mode
  const isHumanMode = () => currentLogMode === LogMode.HUMAN;

  // Convenience wrapper
  const loggerInstance = {
    // Agent logs (structured JSON to stdout)
    agent: (message: any) => {
      // Only log to agentLogger if we're in STRUCTURED mode or agent logs are explicitly enabled
      if (currentLogMode === LogMode.HUMAN && !enableAgentLogs) {
        return;
      }
      agentLogger.info(message);
    },
    debug: (message: string, context?: LogContext) => {
      // In HUMAN mode (for CLI), suppress debug logs unless explicitly enabled
      if (currentLogMode === LogMode.HUMAN && !enableAgentLogs) {
        // No-op in HUMAN mode to prevent "no transports" warning
        return;
      }
      // Otherwise, use agentLogger as normal
      if (context) {
        agentLogger.debug(message, context as unknown);
      } else {
        agentLogger.debug(message);
      }
    },
    info: (message: string, context?: LogContext) => {
      // Only log to agentLogger if we're in STRUCTURED mode or agent logs are explicitly enabled
      if (currentLogMode === LogMode.HUMAN && !enableAgentLogs) {
        return;
      }
      if (context) {
        agentLogger.info(message, context as unknown);
      } else {
        agentLogger.info(message);
      }
    },
    warn: (message: string, context?: LogContext) => {
      // Only log to agentLogger if we're in STRUCTURED mode or agent logs are explicitly enabled
      if (currentLogMode === LogMode.HUMAN && !enableAgentLogs) {
        return;
      }
      if (context) {
        agentLogger.warn(message, context as unknown);
      } else {
        agentLogger.warn(message);
      }
    },
    error: (
      message: string,
      context?: LogContext | Error | { originalError?: any; stack?: string; [key: string]: any }
    ) => {
      // For errors, in HUMAN mode route to programLogger.error instead of suppressing
      if (currentLogMode === LogMode.HUMAN && !enableAgentLogs) {
        // Format the error for the programLogger
        if (context instanceof Error) {
          programLogger.error(`${message}: ${context.message}`);
          if (context.stack) {
            programLogger.error(context.stack);
          }
        } else if (
          typeof context === "object" &&
          context !== null &&
          (context.originalError || context.stack)
        ) {
          programLogger.error(
            `${message}: ${context.originalError || JSON.stringify(context as unknown)}`
          );
          if (context.stack) {
            programLogger.error(context.stack);
          }
        } else {
          programLogger.error(message, context as unknown);
        }
        return;
      }

      // In STRUCTURED mode or if agent logs explicitly enabled, use agentLogger
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
        agentLogger.error(message, context as unknown);
      } else {
        agentLogger.error(message, context as unknown);
      }
    },
    // Program/CLI logs (plain text to stderr)
    cli: (message: any) => programLogger.info(String(message)),
    cliWarn: (message: any) => programLogger.warn(String(message)),
    cliError: (message: any) => programLogger.error(String(message)),
    // Add ability to set log level
    setLevel: (level: string) => {
      agentLogger.level = level;
      programLogger.level = level;
    },
    // Add additional CLI-oriented debug log
    cliDebug: (message: any) => programLogger.debug(String(message)),
    // Add system-level debug logging that always goes to stderr, bypassing the mode limitations
    // Use this for important system debugging that should always be visible when debug level is set
    systemDebug: (message: any) => {
      // Always log to programLogger (stderr) regardless of mode
      programLogger.debug(String(message));
    },
    // Expose log mode information
    mode: currentLogMode,
    isStructuredMode,
    isHumanMode,
    // Expose configuration for testing
    config: loggerConfig,
    // Expose internal loggers for special cases like exit handlers
    _internal: {
      programLogger,
      agentLogger,
    },
  };

  return loggerInstance;
}

// Create default logger instance for backward compatibility
const defaultLogger = createLogger();

// Export the default logger for backward compatibility
export const log = defaultLogger;
export const isStructuredMode = defaultLogger.isStructuredMode;
export const isHumanMode = defaultLogger.isHumanMode;

// Export the factory function for dependency injection
export { createLogger as createConfigurableLogger };

// Ensure logs are written before exiting on unhandled exceptions/rejections
const handleExit = async (error?: Error) => {
  if (error) {
    // Use default logger's internal program logger for unhandled errors that might crash the CLI
    defaultLogger._internal.programLogger.error("Unhandled error or rejection, exiting.", error as unknown);
  }
  // Give logs a moment to flush
  await new Promise((resolve) => setTimeout(resolve, 100));
};

// Basic test to ensure it works - can be removed or moved to a test file
if (process.env.RUN_LOGGER_TEST === "true") {
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
  log.cli(`Is Terminal (TTY): ${Boolean(process.stdout.isTTY)}`);
}
