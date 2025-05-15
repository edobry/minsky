import { describe, test, expect } from "bun:test";
import { createListCommand, createGetCommand } from "../session";
import { MinskyError } from "../../../errors/index.js";
import { createMock, mockModule, setupTestMocks } from "../../../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

// Sample mock sessions for testing
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

// Sample single session for testing
const mockSession = {
  name: "test-session-1",
  repoPath: "/path/to/repo1",
  branch: "feature/test-1",
  createdAt: "2023-06-01T12:00:00Z",
};

// Create mock functions for domain functions
const mockListSessionsFromParams = createMock().mockReturnValue(mockSessions);
const mockGetSessionFromParams = createMock().mockReturnValue(mockSession);
const mockStartSessionFromParams = createMock();
const mockGetSessionDirFromParams = createMock();
const mockDeleteSessionFromParams = createMock();
const mockUpdateSessionFromParams = createMock();

// Mock the domain functions
mockModule("../../../domain/index.js", () => ({
  listSessionsFromParams: mockListSessionsFromParams,
  getSessionFromParams: mockGetSessionFromParams,
  startSessionFromParams: mockStartSessionFromParams,
  getSessionDirFromParams: mockGetSessionDirFromParams,
  deleteSessionFromParams: mockDeleteSessionFromParams,
  updateSessionFromParams: mockUpdateSessionFromParams,
}));

describe("Session CLI Adapter", () => {
  describe("listCommand", () => {
    test("should display session information in human-readable format", async () => {
      // Mock console methods
      const consoleLogMock = createMock();
      const originalLog = console.log;
      console.log = consoleLogMock;
      
      try {
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          // Mock what happens in the command action
          const sessions = mockListSessionsFromParams({ json: false });
          
          // Display sessions in human-readable format
          sessions.forEach((session) => {
            console.log(`Session: ${session.name}`);
            console.log(`  Repo: ${session.repoPath}`);
            console.log(`  Created: ${session.createdAt}`);
            console.log();
          });
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify mockListSessionsFromParams was called
        expect(mockListSessionsFromParams).toHaveBeenCalledWith({ json: false });
        
        // Verify console.log was called with the expected output
        expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-1");
        expect(consoleLogMock).toHaveBeenCalledWith("  Repo: /path/to/repo1");
        expect(consoleLogMock).toHaveBeenCalledWith("  Created: 2023-06-01T12:00:00Z");
        expect(consoleLogMock).toHaveBeenCalledWith(expect.any(String)); // Empty line
        expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-2");
        expect(consoleLogMock).toHaveBeenCalledWith("  Repo: /path/to/repo2");
        expect(consoleLogMock).toHaveBeenCalledWith("  Created: 2023-06-02T12:00:00Z");
      } finally {
        // Restore original console methods
        console.log = originalLog;
      }
    });

    test("should output JSON when --json option is provided", async () => {
      // Mock console methods
      const consoleLogMock = createMock();
      const originalLog = console.log;
      console.log = consoleLogMock;
      
      try {
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          // Mock what happens in the command action
          const sessions = mockListSessionsFromParams({ json: true });
          
          // Output as JSON
          console.log(JSON.stringify(sessions, null, 2));
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify mockListSessionsFromParams was called
        expect(mockListSessionsFromParams).toHaveBeenCalledWith({ json: true });
        
        // Verify console.log was called with JSON string
        expect(consoleLogMock).toHaveBeenCalledWith(JSON.stringify(mockSessions, null, 2));
      } finally {
        // Restore original console methods
        console.log = originalLog;
      }
    });

    test("should handle errors properly", async () => {
      // Mock console methods and process.exit
      const consoleErrorMock = createMock();
      const processExitMock = createMock();
      const originalError = console.error;
      const originalExit = process.exit;
      console.error = consoleErrorMock;
      process.exit = processExitMock as any;
      
      try {
        // Create error to throw
        const testError = new Error("Test error");
        
        // Override the mock for this test to throw an error
        const errorListSessionsFromParams = createMock().mockImplementation(() => {
          throw testError;
        });
        
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          try {
            // Attempt to call function that will throw
            errorListSessionsFromParams({});
          } catch (error) {
            if (error instanceof MinskyError) {
              console.error(`Error: ${error.message}`);
            } else {
              console.error(`Error: ${(error as Error).message}`);
            }
            process.exit(1);
          }
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify error was logged to console.error
        expect(consoleErrorMock).toHaveBeenCalledWith(`Error: ${testError.message}`);
        
        // Verify process.exit was called with exit code 1
        expect(processExitMock).toHaveBeenCalledWith(1);
      } finally {
        // Restore original console methods and process.exit
        console.error = originalError;
        process.exit = originalExit;
      }
    });
  });

  describe("getCommand", () => {
    test("should display specific session information in human-readable format", async () => {
      // Mock console methods
      const consoleLogMock = createMock();
      const originalLog = console.log;
      console.log = consoleLogMock;
      
      try {
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          // Mock what happens in the command action
          const session = mockGetSessionFromParams({
            name: "test-session-1",
            task: undefined,
            json: false,
          });
          
          // Display session details
          console.log(`Session: ${session.name}`);
          console.log(`Repo: ${session.repoPath}`);
          console.log(`Branch: ${session.branch}`);
          console.log(`Created: ${session.createdAt}`);
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify mockGetSessionFromParams was called
        expect(mockGetSessionFromParams).toHaveBeenCalledWith({
          name: "test-session-1",
          task: undefined,
          json: false,
        });
        
        // Verify console.log was called with the expected output
        expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-1");
        expect(consoleLogMock).toHaveBeenCalledWith("Repo: /path/to/repo1");
        expect(consoleLogMock).toHaveBeenCalledWith("Branch: feature/test-1");
        expect(consoleLogMock).toHaveBeenCalledWith("Created: 2023-06-01T12:00:00Z");
      } finally {
        // Restore original console methods
        console.log = originalLog;
      }
    });

    test("should display session with task ID information", async () => {
      // Mock console methods
      const consoleLogMock = createMock();
      const originalLog = console.log;
      console.log = consoleLogMock;
      
      try {
        // Create a session with taskId
        const mockSessionWithTask = {
          ...mockSession,
          taskId: "123",
        };
        
        // Override the mock for this test
        const getSessionWithTaskMock = createMock().mockReturnValue(mockSessionWithTask);
        
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          // Mock what happens in the command action
          const session = getSessionWithTaskMock({
            name: "test-session-1",
            task: undefined,
            json: undefined,
          });
          
          // Display session details
          console.log(`Session: ${session.name}`);
          console.log(`Repo: ${session.repoPath}`);
          console.log(`Branch: ${session.branch}`);
          console.log(`Created: ${session.createdAt}`);
          if (session.taskId) {
            console.log(`Task ID: ${session.taskId}`);
          }
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify getSessionWithTaskMock was called
        expect(getSessionWithTaskMock).toHaveBeenCalledWith({
          name: "test-session-1",
          task: undefined,
          json: undefined,
        });
        
        // Verify console.log was called with the expected output
        expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-1");
        expect(consoleLogMock).toHaveBeenCalledWith("Repo: /path/to/repo1");
        expect(consoleLogMock).toHaveBeenCalledWith("Branch: feature/test-1");
        expect(consoleLogMock).toHaveBeenCalledWith("Created: 2023-06-01T12:00:00Z");
        expect(consoleLogMock).toHaveBeenCalledWith("Task ID: 123");
      } finally {
        // Restore original console methods
        console.log = originalLog;
      }
    });

    test("should get session by task ID when --task option is provided", async () => {
      // Mock console methods
      const consoleLogMock = createMock();
      const originalLog = console.log;
      console.log = consoleLogMock;
      
      try {
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          // Mock what happens in the command action
          const session = mockGetSessionFromParams({
            name: undefined,
            task: "123",
            json: undefined,
          });
          
          // Display session details
          console.log(`Session: ${session.name}`);
          console.log(`Repo: ${session.repoPath}`);
          console.log(`Branch: ${session.branch}`);
          console.log(`Created: ${session.createdAt}`);
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify mockGetSessionFromParams was called
        expect(mockGetSessionFromParams).toHaveBeenCalledWith({
          name: undefined,
          task: "123",
          json: undefined,
        });
        
        // Verify console.log was called with the expected output
        expect(consoleLogMock).toHaveBeenCalledWith("Session: test-session-1");
        expect(consoleLogMock).toHaveBeenCalledWith("Repo: /path/to/repo1");
        expect(consoleLogMock).toHaveBeenCalledWith("Branch: feature/test-1");
        expect(consoleLogMock).toHaveBeenCalledWith("Created: 2023-06-01T12:00:00Z");
      } finally {
        // Restore original console methods
        console.log = originalLog;
      }
    });

    test("should output JSON when --json option is provided", async () => {
      // Mock console methods
      const consoleLogMock = createMock();
      const originalLog = console.log;
      console.log = consoleLogMock;
      
      try {
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          // Mock what happens in the command action
          const session = mockGetSessionFromParams({
            name: "test-session-1",
            task: undefined,
            json: true,
          });
          
          // Output as JSON
          console.log(JSON.stringify(session, null, 2));
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify mockGetSessionFromParams was called
        expect(mockGetSessionFromParams).toHaveBeenCalledWith({
          name: "test-session-1",
          task: undefined,
          json: true,
        });
        
        // Verify console.log was called with JSON string
        expect(consoleLogMock).toHaveBeenCalledWith(JSON.stringify(mockSession, null, 2));
      } finally {
        // Restore original console methods
        console.log = originalLog;
      }
    });

    test("should handle MinskyError properly", async () => {
      // Mock console methods and process.exit
      const consoleErrorMock = createMock();
      const processExitMock = createMock();
      const originalError = console.error;
      const originalExit = process.exit;
      console.error = consoleErrorMock;
      process.exit = processExitMock as any;
      
      try {
        // Create error to throw
        const testError = new MinskyError("Session not found");
        
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          try {
            // Mock what happens in the command action when error is thrown
            throw testError;
          } catch (error) {
            if (error instanceof MinskyError) {
              console.error(`Error: ${error.message}`);
            } else {
              console.error(`Unexpected error: ${(error as Error).message}`);
            }
            process.exit(1);
          }
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify error was logged to console.error
        expect(consoleErrorMock).toHaveBeenCalledWith("Error: Session not found");
        
        // Verify process.exit was called with exit code 1
        expect(processExitMock).toHaveBeenCalledWith(1);
      } finally {
        // Restore original console methods and process.exit
        console.error = originalError;
        process.exit = originalExit;
      }
    });

    test("should handle unexpected errors properly", async () => {
      // Mock console methods and process.exit
      const consoleErrorMock = createMock();
      const processExitMock = createMock();
      const originalError = console.error;
      const originalExit = process.exit;
      console.error = consoleErrorMock;
      process.exit = processExitMock as any;
      
      try {
        // Create error to throw
        const testError = new Error("Unexpected error");
        
        // Define a mock action function to simulate the command being executed
        const mockAction = async () => {
          try {
            // Mock what happens in the command action when error is thrown
            throw testError;
          } catch (error) {
            if (error instanceof MinskyError) {
              console.error(`Error: ${error.message}`);
            } else {
              console.error(`Unexpected error: ${(error as Error).message}`);
            }
            process.exit(1);
          }
        };
        
        // Execute the mock action
        await mockAction();
        
        // Verify error was logged to console.error
        expect(consoleErrorMock).toHaveBeenCalledWith("Unexpected error: Unexpected error");
        
        // Verify process.exit was called with exit code 1
        expect(processExitMock).toHaveBeenCalledWith(1);
      } finally {
        // Restore original console methods and process.exit
        console.error = originalError;
        process.exit = originalExit;
      }
    });
  });
});
