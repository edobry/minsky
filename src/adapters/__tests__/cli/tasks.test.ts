/**
 * Tests for the tasks CLI commands
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { createStatusCommand } from "../../../adapters/cli/tasks.js";
import {
  createMock,
  mockModule,
  setupTestMocks,
} from "../../../utils/test-utils/mocking.js";

// No need to import Command directly if we're not using it
// We only need the createStatusCommand function

// Set up automatic mock cleanup
setupTestMocks();

// Mock the getCurrentSessionContext function
const mockGetCurrentSessionContext = createMock(async () => {
  return { sessionId: "test-session", taskId: "123" };
});

// Mock domain functions
const mockSetTaskStatusFromParams = createMock(async () => {
  return true;
});

// Mock the process.exit
const originalExit = process.exit;
const mockExit = createMock(() => {
  return undefined as never;
});

// Mock logger functions
const mockLogCli = createMock();
const mockLogCliError = createMock();
const mockLogError = createMock();

describe("tasks CLI commands", () => {
  beforeEach(() => {
    // Setup mocks
    process.exit = mockExit;

    // Reset call counts
    mockGetCurrentSessionContext.mockClear();
    mockSetTaskStatusFromParams.mockClear();
    mockExit.mockClear();
    mockLogCli.mockClear();
    mockLogCliError.mockClear();
    mockLogError.mockClear();

    // Mock the import for getCurrentSessionContext
    mockModule("../../../domain/workspace.js", () => ({
      getCurrentSessionContext: mockGetCurrentSessionContext,
    }));

    // Mock the import for setTaskStatusFromParams
    mockModule("../../../domain/tasks.js", () => ({
      setTaskStatusFromParams: mockSetTaskStatusFromParams,
      normalizeTaskId: (id: string) => id,
      TASK_STATUS: {
        TODO: "TODO",
        IN_PROGRESS: "IN-PROGRESS",
        DONE: "DONE"
      }
    }));

    // Mock the logger
    mockModule("../../../utils/logger", () => ({
      log: {
        cli: mockLogCli,
        cliError: mockLogCliError,
        error: mockLogError,
        debug: createMock(),
      },
    }));
  });

  afterEach(() => {
    // Restore original process.exit
    process.exit = originalExit;
  });

  describe("status set command", () => {
    test("auto-detects task ID when not provided", async () => {
      const statusCommand = createStatusCommand();

      // Parse the command with no task-id, only status
      await statusCommand.parseAsync(["set", "IN-PROGRESS"], { from: "user" });

      // Verify getCurrentSessionContext was called
      expect(mockGetCurrentSessionContext.mock.calls.length).toBeGreaterThan(0);

      // Verify auto-detection feedback was shown
      expect(mockLogCli).toHaveBeenCalledWith("Auto-detected task: 123");

      // Verify setTaskStatusFromParams was called with auto-detected task ID
      expect(mockSetTaskStatusFromParams).toHaveBeenCalledWith({
        taskId: "123",
        status: "IN-PROGRESS",
        json: undefined,
        repo: undefined,
        session: undefined,
        workspace: undefined,
        backend: undefined,
      });
    });

    test("uses provided task ID when available", async () => {
      const statusCommand = createStatusCommand();

      // Parse the command with explicit task-id and status
      await statusCommand.parseAsync(["set", "456", "DONE"], { from: "user" });

      // Verify getCurrentSessionContext was NOT called
      expect(mockGetCurrentSessionContext.mock.calls.length).toBe(0);

      // Verify setTaskStatusFromParams was called with the provided task ID
      expect(mockSetTaskStatusFromParams).toHaveBeenCalledWith({
        taskId: "456",
        status: "DONE",
        json: undefined,
        repo: undefined,
        session: undefined,
        workspace: undefined,
        backend: undefined,
      });
    });

    test("handles failure to auto-detect task ID", async () => {
      // Mock getCurrentSessionContext to return null
      mockGetCurrentSessionContext.mockImplementationOnce(async () => null);

      const statusCommand = createStatusCommand();

      // Parse the command with no task-id, only status
      await statusCommand.parseAsync(["set", "IN-PROGRESS"], { from: "user" });

      // Verify getCurrentSessionContext was called
      expect(mockGetCurrentSessionContext.mock.calls.length).toBeGreaterThan(0);

      // Verify error message was shown
      expect(mockLogCliError).toHaveBeenCalledWith(
        "No task ID provided and could not auto-detect from current session."
      );

      // Verify process.exit was called with error code
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
}); 
