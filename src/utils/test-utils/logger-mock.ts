import { mock } from "bun:test";

/**
 * Centralized logger mock factory for consistent test mocking
 * Includes all logger methods to prevent "log.cli is not a function" errors
 */
export function createMockLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    agent: mock(() => {}),
    cli: mock(() => {}),
    cliWarn: mock(() => {}),
    cliError: mock(() => {}),
    cliDebug: mock(() => {}),
    systemDebug: mock(() => {}),
    setLevel: mock(() => {}),
    mode: "HUMAN",
    isStructuredMode: mock(() => false),
    isHumanMode: mock(() => true),
    config: {
      mode: "HUMAN" as const,
      level: "debug" as const,
      enableAgentLogs: false,
    },
    _internal: {
      programLogger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
      agentLogger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
    },
  };
}

/**
 * Clear all mocks on the logger instance
 */
export function clearLoggerMocks(mockLog: ReturnType<typeof createMockLogger>) {
  // Clear main logger mocks
  mockLog.debug.mockClear();
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
  mockLog.agent.mockClear();
  mockLog.cli.mockClear();
  mockLog.cliWarn.mockClear();
  mockLog.cliError.mockClear();
  mockLog.cliDebug.mockClear();
  mockLog.systemDebug.mockClear();
  mockLog.setLevel.mockClear();
  mockLog.isStructuredMode.mockClear();
  mockLog.isHumanMode.mockClear();

  // Clear internal logger mocks
  mockLog._internal.programLogger.debug.mockClear();
  mockLog._internal.programLogger.info.mockClear();
  mockLog._internal.programLogger.warn.mockClear();
  mockLog._internal.programLogger.error.mockClear();
  mockLog._internal.agentLogger.debug.mockClear();
  mockLog._internal.agentLogger.info.mockClear();
  mockLog._internal.agentLogger.warn.mockClear();
  mockLog._internal.agentLogger.error.mockClear();
}
