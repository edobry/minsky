import { describe, test, expect, jest, mock, afterEach, beforeEach } from "bun:test";
import { createListCommand, createGetCommand } from "../session";
import * as domain from "../../../domain/index.js";
import { MinskyError } from "../../../errors/index.js";

// Mock the domain functions used by the adapter
mock.module("../../../domain/index.js", () => ({
  listSessionsFromParams: jest.fn(),
  getSessionFromParams: jest.fn(),
  startSessionFromParams: jest.fn(),
  getSessionDirFromParams: jest.fn(),
  deleteSessionFromParams: jest.fn(),
  updateSessionFromParams: jest.fn(),
}));

const mockSessions = [
  {
    name: "test-session-1",
    repoPath: "/path/to/repo1",
    branch: "feature/test-1",
    createdAt: "2023-06-01T12:00:00Z",
  },
  {
    name: "test-session-2",
    repoPath: "/path/to/repo2",
    branch: "feature/test-2",
    createdAt: "2023-06-02T12:00:00Z",
    taskId: "123",
  },
];

const mockSession = {
  name: "test-session-1",
  repoPath: "/path/to/repo1",
  branch: "feature/test-1",
  createdAt: "2023-06-01T12:00:00Z",
};

describe("Session CLI Adapter", () => {
  // Store original console methods to restore them after tests
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  
  // Mock console.log and console.error for testing output
  let consoleLogMock: jest.Mock;
  let consoleErrorMock: jest.Mock;
  
  // Mock process.exit to prevent tests from exiting
  const originalProcessExit = process.exit;
  let processExitMock: jest.Mock;

  beforeEach(() => {
    // Reset mocks before each test
    jest.resetAllMocks();
    
    // Mock console methods
    consoleLogMock = jest.fn();
    consoleErrorMock = jest.fn();
    console.log = consoleLogMock;
    console.error = consoleErrorMock;
    
    // Mock process.exit
    processExitMock = jest.fn();
    process.exit = processExitMock as any;
  });

  afterEach(() => {
    // Restore original console methods and process.exit
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
  });

  describe("listCommand", () => {
    test("should display session information in human-readable format", async () => {
      // Mock the domain function to return test data
      (domain.listSessionsFromParams as jest.Mock).mockResolvedValue(mockSessions);
      
      // Create the command
      const listCommand = createListCommand();
      
      // Execute the command's action function with no options (default human-readable output)
      await listCommand.action({ json: false });
      
      // Verify domain function was called with correct parameters
      expect(domain.listSessionsFromParams).toHaveBeenCalledWith({ json: false });
      
      // Verify console.log was called with the expected output
      expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-1");
      expect(consoleLogMock).toHaveBeenCalledWith("  Repo: /path/to/repo1");
      expect(consoleLogMock).toHaveBeenCalledWith("  Created: 2023-06-01T12:00:00Z");
      expect(consoleLogMock).toHaveBeenCalledWith(expect.any(String)); // Empty line
      expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-2");
      expect(consoleLogMock).toHaveBeenCalledWith("  Repo: /path/to/repo2");
      expect(consoleLogMock).toHaveBeenCalledWith("  Created: 2023-06-02T12:00:00Z");
      
      // Verify process.exit was not called (no errors)
      expect(processExitMock).not.toHaveBeenCalled();
    });

    test("should output JSON when --json option is provided", async () => {
      // Mock the domain function to return test data
      (domain.listSessionsFromParams as jest.Mock).mockResolvedValue(mockSessions);
      
      // Create the command
      const listCommand = createListCommand();
      
      // Execute the command's action function with json option
      await listCommand.action({ json: true });
      
      // Verify domain function was called with correct parameters
      expect(domain.listSessionsFromParams).toHaveBeenCalledWith({ json: true });
      
      // Verify console.log was called with JSON string
      expect(consoleLogMock).toHaveBeenCalledWith(JSON.stringify(mockSessions, null, 2));
      
      // Verify process.exit was not called (no errors)
      expect(processExitMock).not.toHaveBeenCalled();
    });

    test("should handle errors properly", async () => {
      // Mock the domain function to throw an error
      const testError = new Error("Test error");
      (domain.listSessionsFromParams as jest.Mock).mockRejectedValue(testError);
      
      // Create the command
      const listCommand = createListCommand();
      
      // Execute the command's action function
      await listCommand.action({});
      
      // Verify error was logged to console.error
      expect(consoleErrorMock).toHaveBeenCalledWith(`Error: ${testError.message}`);
      
      // Verify process.exit was called with exit code 1
      expect(processExitMock).toHaveBeenCalledWith(1);
    });
  });

  describe("getCommand", () => {
    test("should display specific session information in human-readable format", async () => {
      // Mock the domain function to return test data
      (domain.getSessionFromParams as jest.Mock).mockResolvedValue(mockSession);
      
      // Create the command
      const getCommand = createGetCommand();
      
      // Execute the command's action function with a session name and default options
      await getCommand.action("test-session-1", { json: false });
      
      // Verify domain function was called with correct parameters
      expect(domain.getSessionFromParams).toHaveBeenCalledWith({
        name: "test-session-1",
        task: undefined,
        json: false
      });
      
      // Verify console.log was called with the expected output
      expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-1");
      expect(consoleLogMock).toHaveBeenCalledWith("Repo: /path/to/repo1");
      expect(consoleLogMock).toHaveBeenCalledWith("Branch: feature/test-1");
      expect(consoleLogMock).toHaveBeenCalledWith("Created: 2023-06-01T12:00:00Z");
      
      // Verify process.exit was not called (no errors)
      expect(processExitMock).not.toHaveBeenCalled();
    });

    test("should display session with task ID information", async () => {
      // Create a mock session with taskId
      const mockSessionWithTask = {
        ...mockSession,
        taskId: "123"
      };
      
      // Mock the domain function to return test data
      (domain.getSessionFromParams as jest.Mock).mockResolvedValue(mockSessionWithTask);
      
      // Create the command
      const getCommand = createGetCommand();
      
      // Execute the command's action function
      await getCommand.action("test-session-1", {});
      
      // Verify domain function was called with correct parameters
      expect(domain.getSessionFromParams).toHaveBeenCalledWith({
        name: "test-session-1",
        task: undefined,
        json: undefined
      });
      
      // Verify console.log was called with the expected output including task ID
      expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-1");
      expect(consoleLogMock).toHaveBeenCalledWith("Repo: /path/to/repo1");
      expect(consoleLogMock).toHaveBeenCalledWith("Branch: feature/test-1");
      expect(consoleLogMock).toHaveBeenCalledWith("Created: 2023-06-01T12:00:00Z");
      expect(consoleLogMock).toHaveBeenCalledWith("Task ID: 123");
      
      // Verify process.exit was not called (no errors)
      expect(processExitMock).not.toHaveBeenCalled();
    });

    test("should get session by task ID when --task option is provided", async () => {
      // Mock the domain function to return test data
      (domain.getSessionFromParams as jest.Mock).mockResolvedValue(mockSession);
      
      // Create the command
      const getCommand = createGetCommand();
      
      // Execute the command's action function with task option
      await getCommand.action(undefined, { task: "123" });
      
      // Verify domain function was called with correct parameters
      expect(domain.getSessionFromParams).toHaveBeenCalledWith({
        name: undefined,
        task: "123",
        json: undefined
      });
      
      // Verify console.log was called with the expected output
      expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-1");
      expect(consoleLogMock).toHaveBeenCalledWith("Repo: /path/to/repo1");
      expect(consoleLogMock).toHaveBeenCalledWith("Branch: feature/test-1");
      expect(consoleLogMock).toHaveBeenCalledWith("Created: 2023-06-01T12:00:00Z");
      
      // Verify process.exit was not called (no errors)
      expect(processExitMock).not.toHaveBeenCalled();
    });

    test("should output JSON when --json option is provided", async () => {
      // Mock the domain function to return test data
      (domain.getSessionFromParams as jest.Mock).mockResolvedValue(mockSession);
      
      // Create the command
      const getCommand = createGetCommand();
      
      // Execute the command's action function with json option
      await getCommand.action("test-session-1", { json: true });
      
      // Verify domain function was called with correct parameters
      expect(domain.getSessionFromParams).toHaveBeenCalledWith({
        name: "test-session-1",
        task: undefined,
        json: true
      });
      
      // Verify console.log was called with JSON string
      expect(consoleLogMock).toHaveBeenCalledWith(JSON.stringify(mockSession, null, 2));
      
      // Verify process.exit was not called (no errors)
      expect(processExitMock).not.toHaveBeenCalled();
    });

    test("should handle MinskyError properly", async () => {
      // Mock the domain function to throw a MinskyError
      const testError = new MinskyError("Session not found");
      (domain.getSessionFromParams as jest.Mock).mockRejectedValue(testError);
      
      // Create the command
      const getCommand = createGetCommand();
      
      // Execute the command's action function
      await getCommand.action("non-existent", {});
      
      // Verify error was logged to console.error
      expect(consoleErrorMock).toHaveBeenCalledWith("Error: Session not found");
      
      // Verify process.exit was called with exit code 1
      expect(processExitMock).toHaveBeenCalledWith(1);
    });

    test("should handle unexpected errors properly", async () => {
      // Mock the domain function to throw a non-Minsky error
      const testError = new Error("Unexpected error");
      (domain.getSessionFromParams as jest.Mock).mockRejectedValue(testError);
      
      // Create the command
      const getCommand = createGetCommand();
      
      // Execute the command's action function
      await getCommand.action("test-session", {});
      
      // Verify error was logged to console.error
      expect(consoleErrorMock).toHaveBeenCalledWith("Unexpected error: Unexpected error");
      
      // Verify process.exit was called with exit code 1
      expect(processExitMock).toHaveBeenCalledWith(1);
    });
  });
}); 
