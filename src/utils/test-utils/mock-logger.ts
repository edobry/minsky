/**
 * Mock Logger for Tests
 *
 * Provides an in-memory logger that captures log output instead of printing to console,
 * eliminating noise in test output while preserving the ability to test logging behavior.
 */

import { type LoggerConfig, LogMode, type LogContext } from "../logger";

export interface LogEntry {
  level: string;
  message: string;
  metadata?: LogContext;
  timestamp: number;
}

export interface MockLoggerInterface {
  // Core logging methods
  agent: (message: string, metadata?: LogContext) => void;
  debug: (message: string, metadata?: LogContext) => void;
  info: (message: string, metadata?: LogContext) => void;
  warn: (message: string, metadata?: LogContext) => void;
  error: (message: string | Error, metadata?: LogContext) => void;

  // CLI-specific methods
  cli: (message: string, metadata?: LogContext) => void;
  cliDebug: (message: string, metadata?: LogContext) => void;
  cliWarn: (message: string, metadata?: LogContext) => void;
  cliError: (message: string | Error, metadata?: LogContext) => void;
  systemDebug: (message: string, metadata?: LogContext) => void;

  // Configuration and mode
  mode: string;
  isStructuredMode: () => boolean;
  isHumanMode: () => boolean;
  config: LoggerConfig;

  // Internal for testing - use unknown to avoid depending on winston internals
  _internal: {
    programLogger: unknown;
    agentLogger: unknown;
  };

  // Mock-specific methods for testing
  _mock: {
    clear: () => void;
    getAllLogs: () => LogEntry[];
    getLogsByLevel: (level: string) => LogEntry[];
    getLastLog: () => LogEntry | undefined;
    getLogCount: () => number;
    hasLoggedError: () => boolean;
    hasLoggedWarning: () => boolean;
  };
}

/**
 * Creates a mock logger that captures logs in memory instead of outputting to console
 */
export function createMockLogger(configOverride?: LoggerConfig): MockLoggerInterface {
  const logs: LogEntry[] = [];

  const loggerConfig: LoggerConfig =
    configOverride ||
    ({
      mode: "auto",
      level: "error", // Default to error level in tests (effectively silent)
      enableAgentLogs: false,
    } as LoggerConfig);

  const currentLogMode: LogMode = LogMode.HUMAN; // Default to human mode in tests

  function addLog(level: string, message: string | Error, metadata?: LogContext) {
    const entry: LogEntry = {
      level,
      message: message instanceof Error ? message.message : message,
      metadata: metadata || (message instanceof Error ? { stack: message.stack } : undefined),
      timestamp: Date.now(),
    };
    logs.push(entry);
  }

  // Create in-memory logger methods that share the addLog function
  const internalLogger = {
    error: (message: string, error?: LogContext) => addLog("error", message, error),
    warn: (message: string, metadata?: LogContext) => addLog("warn", message, metadata),
    info: (message: string, metadata?: LogContext) => addLog("info", message, metadata),
    debug: (message: string, metadata?: LogContext) => addLog("debug", message, metadata),
  };

  // Create mock logger methods
  const mockLogger: MockLoggerInterface = {
    // Core logging methods
    agent: (message: string, metadata?: LogContext) => addLog("info", message, metadata),
    debug: (message: string, metadata?: LogContext) => addLog("debug", message, metadata),
    info: (message: string, metadata?: LogContext) => addLog("info", message, metadata),
    warn: (message: string, metadata?: LogContext) => addLog("warn", message, metadata),
    error: (message: string | Error, metadata?: LogContext) => addLog("error", message, metadata),

    // CLI-specific methods
    cli: (message: string, metadata?: LogContext) => addLog("info", message, metadata),
    cliDebug: (message: string, metadata?: LogContext) => addLog("debug", message, metadata),
    cliWarn: (message: string, metadata?: LogContext) => addLog("warn", message, metadata),
    cliError: (message: string | Error, metadata?: LogContext) =>
      addLog("error", message, metadata),
    systemDebug: (message: string, metadata?: LogContext) => addLog("debug", message, metadata),

    // Configuration and mode
    mode: (currentLogMode as LogMode) === LogMode.STRUCTURED ? "STRUCTURED" : "HUMAN",
    isStructuredMode: () => (currentLogMode as LogMode) === LogMode.STRUCTURED,
    isHumanMode: () => (currentLogMode as LogMode) === LogMode.HUMAN,
    config: loggerConfig,

    // Internal (empty mocks for compatibility)
    _internal: {
      programLogger: internalLogger,
      agentLogger: internalLogger,
    },

    // Mock-specific testing methods
    _mock: {
      clear: () => (logs.length = 0),
      getAllLogs: () => [...logs],
      getLogsByLevel: (level: string) => logs.filter((log) => log.level === level),
      getLastLog: () => logs[logs.length - 1],
      getLogCount: () => logs.length,
      hasLoggedError: () => logs.some((log) => log.level === "error"),
      hasLoggedWarning: () => logs.some((log) => log.level === "warn"),
    },
  };

  return mockLogger;
}

/**
 * Global mock logger instance for tests
 */
export const mockLogger = createMockLogger();

/**
 * Reset the mock logger between tests
 */
export function resetMockLogger(): void {
  mockLogger._mock.clear();
}

/**
 * Helper to check if specific message was logged
 */
export function wasMessageLogged(message: string, level?: string): boolean {
  const logs = level ? mockLogger._mock.getLogsByLevel(level) : mockLogger._mock.getAllLogs();
  return logs.some((log) => log.message.includes(message));
}

/**
 * Helper to get all error messages logged
 */
export function getLoggedErrors(): string[] {
  return mockLogger._mock.getLogsByLevel("error").map((log) => log.message);
}

/**
 * Helper to get all warning messages logged
 */
export function getLoggedWarnings(): string[] {
  return mockLogger._mock.getLogsByLevel("warn").map((log) => log.message);
}
