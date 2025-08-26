/**
 * Mock Logger for Tests
 *
 * Provides an in-memory logger that captures log output instead of printing to console,
 * eliminating noise in test output while preserving the ability to test logging behavior.
 */

import { type LoggerConfig, LogMode } from "../logger";

export interface LogEntry {
  level: string;
  message: string;
  metadata?: any;
  timestamp: number;
}

export interface MockLoggerInterface {
  // Core logging methods
  agent: (message: string, metadata?: any) => void;
  debug: (message: string, metadata?: any) => void;
  info: (message: string, metadata?: any) => void;
  warn: (message: string, metadata?: any) => void;
  error: (message: string | Error, metadata?: any) => void;

  // CLI-specific methods
  cli: (message: string, metadata?: any) => void;
  cliDebug: (message: string, metadata?: any) => void;
  cliWarn: (message: string, metadata?: any) => void;
  cliError: (message: string | Error, metadata?: any) => void;
  systemDebug: (message: string, metadata?: any) => void;

  // Configuration and mode
  mode: string;
  isStructuredMode: () => boolean;
  isHumanMode: () => boolean;
  config: LoggerConfig;

  // Internal for testing
  _internal: {
    programLogger: any;
    agentLogger: any;
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

  const loggerConfig: LoggerConfig = configOverride || {
    mode: "auto",
    level: "silent", // Default to silent in tests
    enableAgentLogs: false,
  };

  const currentLogMode = LogMode.HUMAN; // Default to human mode in tests

  function addLog(level: string, message: string | Error, metadata?: any) {
    const entry: LogEntry = {
      level,
      message: message instanceof Error ? message.message : message,
      metadata: metadata || (message instanceof Error ? { stack: message.stack } : undefined),
      timestamp: Date.now(),
    };
    logs.push(entry);
  }

  // Create mock logger methods
  const mockLogger: MockLoggerInterface = {
    // Core logging methods
    agent: (message: string, metadata?: any) => addLog("info", message, metadata),
    debug: (message: string, metadata?: any) => addLog("debug", message, metadata),
    info: (message: string, metadata?: any) => addLog("info", message, metadata),
    warn: (message: string, metadata?: any) => addLog("warn", message, metadata),
    error: (message: string | Error, metadata?: any) => addLog("error", message, metadata),

    // CLI-specific methods
    cli: (message: string, metadata?: any) => addLog("info", message, metadata),
    cliDebug: (message: string, metadata?: any) => addLog("debug", message, metadata),
    cliWarn: (message: string, metadata?: any) => addLog("warn", message, metadata),
    cliError: (message: string | Error, metadata?: any) => addLog("error", message, metadata),
    systemDebug: (message: string, metadata?: any) => addLog("debug", message, metadata),

    // Configuration and mode
    mode: currentLogMode === LogMode.STRUCTURED ? "STRUCTURED" : "HUMAN",
    isStructuredMode: () => currentLogMode === LogMode.STRUCTURED,
    isHumanMode: () => currentLogMode === LogMode.HUMAN,
    config: loggerConfig,

    // Internal (empty mocks for compatibility)
    _internal: {
      programLogger: {
        error: (message: string, error?: any) => addLog("error", message, error),
        warn: (message: string, metadata?: any) => addLog("warn", message, metadata),
        info: (message: string, metadata?: any) => addLog("info", message, metadata),
        debug: (message: string, metadata?: any) => addLog("debug", message, metadata),
      },
      agentLogger: {
        error: (message: string, error?: any) => addLog("error", message, error),
        warn: (message: string, metadata?: any) => addLog("warn", message, metadata),
        info: (message: string, metadata?: any) => addLog("info", message, metadata),
        debug: (message: string, metadata?: any) => addLog("debug", message, metadata),
      },
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
