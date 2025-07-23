/**
 * Logger Configuration Schema
 *
 * Defines the schema for logging configuration including log levels, output modes,
 * and logging behavior settings for the Minsky application.
 */

import { z } from "zod";
import { enumSchemas } from "./base";

/**
 * Logger configuration
 */
export const loggerConfigSchema = z
  .object({
    // Logging mode: HUMAN (readable), STRUCTURED (JSON), or auto (detect based on environment)
    mode: enumSchemas.loggerMode.default("auto"),

    // Log level: debug, info, warn, error
    level: enumSchemas.logLevel.default("info"),

    // Whether to enable agent logs in HUMAN mode (additional JSON logs)
    enableAgentLogs: z.boolean().default(false),

    // Whether to include timestamps in log output
    includeTimestamp: z.boolean().default(true),

    // Whether to include log level in output
    includeLevel: z.boolean().default(true),

    // Whether to include source file information in logs
    includeSource: z.boolean().default(false),

    // Custom log file path (optional, defaults to console output)
    logFile: z.string().optional(),

    // Maximum log file size in MB before rotation
    maxFileSize: z.number().min(1).max(1000).default(100),

    // Number of log files to keep during rotation
    maxFiles: z.number().min(1).max(20).default(5),
  })
  .strict()
  .default({
    mode: "auto",
    level: "info",
    enableAgentLogs: false,
    includeTimestamp: true,
    includeLevel: true,
    includeSource: false,
    maxFileSize: 100,
    maxFiles: 5,
  });

// Type exports
export type LoggerMode = z.infer<typeof enumSchemas.loggerMode>;
export type LogLevel = z.infer<typeof enumSchemas.logLevel>;
export type LoggerConfig = z.infer<typeof loggerConfigSchema>;

/**
 * Validation functions for logger configuration
 */
export const loggerValidation = {
  /**
   * Check if a log level is valid
   */
  isValidLogLevel: (level: string): level is LogLevel => {
    return ["debug", "info", "warn", "error"].includes(level);
  },

  /**
   * Check if a logger mode is valid
   */
  isValidLoggerMode: (mode: string): mode is LoggerMode => {
    return ["HUMAN", "STRUCTURED", "auto"].includes(mode);
  },

  /**
   * Get numeric priority for log level (higher = more important)
   */
  getLogLevelPriority: (level: LogLevel): number => {
    switch (level) {
      case "debug":
        return 0;
      case "info":
        return 1;
      case "warn":
        return 2;
      case "error":
        return 3;
      default:
        return 1;
    }
  },

  /**
   * Check if a message should be logged based on current level
   */
  shouldLog: (messageLevel: LogLevel, configLevel: LogLevel): boolean => {
    return (
      loggerValidation.getLogLevelPriority(messageLevel) >=
      loggerValidation.getLogLevelPriority(configLevel)
    );
  },

  /**
   * Resolve the effective logger mode based on environment
   */
  resolveLoggerMode: (config: LoggerConfig): "HUMAN" | "STRUCTURED" => {
    if (config.mode === "auto") {
      // Auto-detect based on environment
      const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
      const isDocker = !!process.env.DOCKER_CONTAINER;
      const hasTerminal = process.stdout.isTTY;

      // Use structured logging in CI/Docker or when no terminal
      if (isCI || isDocker || !hasTerminal) {
        return "STRUCTURED";
      } else {
        return "HUMAN";
      }
    }

    return config.mode;
  },

  /**
   * Get effective log file configuration
   */
  getLogFileConfig: (config: LoggerConfig) => ({
    enabled: !!config.logFile,
    path: config.logFile,
    maxSize: config.maxFileSize * 1024 * 1024, // Convert MB to bytes
    maxFiles: config.maxFiles,
  }),

  /**
   * Validate log file path and permissions
   */
  validateLogFile: (logFile: string): { valid: boolean; error?: string } => {
    try {
      // Basic path validation
      if (!logFile || logFile.trim().length === 0) {
        return { valid: false, error: "Log file path cannot be empty" };
      }

      // Check for invalid characters (basic check)
      if (logFile.includes("\0")) {
        return { valid: false, error: "Log file path contains invalid characters" };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, error: `Invalid log file path: ${error}` };
    }
  },
} as const;

/**
 * Environment variable mapping for logger configuration
 */
export const loggerEnvMapping = {
  // Logger mode
  MINSKY_LOG_MODE: "logger.mode",
  LOG_MODE: "logger.mode",

  // Log level
  LOGLEVEL: "logger.level",
  LOG_LEVEL: "logger.level",
  MINSKY_LOG_LEVEL: "logger.level",

  // Agent logs
  ENABLE_AGENT_LOGS: "logger.enableAgentLogs",
  MINSKY_ENABLE_AGENT_LOGS: "logger.enableAgentLogs",

  // Log file
  LOG_FILE: "logger.logFile",
  MINSKY_LOG_FILE: "logger.logFile",

  // Advanced options
  LOG_INCLUDE_TIMESTAMP: "logger.includeTimestamp",
  LOG_INCLUDE_LEVEL: "logger.includeLevel",
  LOG_INCLUDE_SOURCE: "logger.includeSource",
  LOG_MAX_FILE_SIZE: "logger.maxFileSize",
  LOG_MAX_FILES: "logger.maxFiles",
} as const;

/**
 * Default logger configurations for different environments
 */
export const loggerPresets = {
  development: {
    mode: "HUMAN" as const,
    level: "debug" as const,
    enableAgentLogs: true,
    includeSource: true,
  },

  production: {
    mode: "STRUCTURED" as const,
    level: "info" as const,
    enableAgentLogs: false,
    includeSource: false,
  },

  testing: {
    mode: "STRUCTURED" as const,
    level: "warn" as const,
    enableAgentLogs: false,
    includeSource: false,
  },

  ci: {
    mode: "STRUCTURED" as const,
    level: "info" as const,
    enableAgentLogs: false,
    includeSource: false,
  },
} as const;
