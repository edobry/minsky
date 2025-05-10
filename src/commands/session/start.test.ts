import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createStartCommand } from "./start.js";

// Mock the startSession module
const mockStartSession = mock(() => ({
  sessionRecord: { session: "test-session" },
  cloneResult: { workdir: "/path/to/test-workdir" },
  branchResult: { branch: "test-branch" }
}));

// Mock the repo-utils module
const mockResolveRepoPath = mock(() => "/path/to/repo");

// Mock isSessionRepository function
const mockIsSessionRepository = mock(() => false);

// Setup mocks before importing the actual modules
mock.module("./startSession.js", () => ({
  startSession: mockStartSession
}));

mock.module("../../domain/repo-utils.js", () => ({
  resolveRepoPath: mockResolveRepoPath
}));

mock.module("../../domain/workspace.js", () => ({
  isSessionRepository: mockIsSessionRepository
}));

describe("createStartCommand", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalExit: typeof process.exit;
  
  const logCalls: string[] = [];
  const errorCalls: string[] = [];
  
  beforeEach(() => {
    // Save original functions
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalExit = process.exit;
    
    // Reset mocks
    mockStartSession.mockClear();
    mockResolveRepoPath.mockClear();
    mockIsSessionRepository.mockClear();
    mockIsSessionRepository.mockImplementation(() => false);
    
    // Mock console.log and console.error
    console.log = (...args: any[]) => {
      logCalls.push(args.join(" "));
    };
    
    console.error = (...args: any[]) => {
      errorCalls.push(args.join(" "));
    };
    
    // Mock process.exit
    process.exit = mock((code = 0) => {
      throw new Error(`Exit with code: ${code}`);
    });
    
    // Clear log and error calls
    logCalls.length = 0;
    errorCalls.length = 0;
    
    // Reset mock calls
    mockStartSession.mockClear();
    mockResolveRepoPath.mockClear();
  });
  
  afterEach(() => {
    // Restore original functions
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalExit;
  });
  
  it("outputs verbose information when --quiet is not specified", async () => {
    // Arrange
    const command = createStartCommand();
    
    // Act - execute the command
    await command.parseAsync(["node", "test", "test-session", "--repo", "/path/to/repo"]);
    
    // Assert
    // Should have multiple log lines when not in quiet mode
    expect(logCalls.length).toBeGreaterThan(1);
    
    // Verify specific output messages
    expect(logCalls.some(log => log.includes("Session 'test-session' started."))).toBe(true);
    expect(logCalls.some(log => log.includes("Repository cloned to:"))).toBe(true);
    expect(logCalls.some(log => log.includes("Branch 'test-branch' created."))).toBe(true);
    
    // Should include the workdir as the final output
    expect(logCalls[logCalls.length - 1]).toBe("/path/to/test-workdir");
  });
  
  it("outputs only the session directory path when --quiet is specified", async () => {
    // Arrange
    const command = createStartCommand();
    
    // Act - execute the command with --quiet
    await command.parseAsync(["node", "test", "test-session", "--repo", "/path/to/repo", "--quiet"]);
    
    // Assert
    // Should have exactly one log line in quiet mode
    expect(logCalls.length).toBe(1);
    
    // Should output only the workdir path
    expect(logCalls[0]).toBe("/path/to/test-workdir");
  });
  
  it("properly handles errors in quiet mode", async () => {
    // Arrange
    const command = createStartCommand();
    
    // Mock startSession to throw an error
    mockStartSession.mockImplementationOnce(() => {
      throw new Error("Test error message");
    });
    
    // Track process.exit calls
    let exitCode = 0;
    process.exit = (code = 0) => {
      exitCode = code;
      return undefined as never;
    };
    
    // Act - execute the command with --quiet
    await command.parseAsync(["node", "test", "test-session", "--repo", "/path/to/repo", "--quiet"]);
    
    // Assert
    // Should log the error
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0]).toContain("Error starting session:");
    expect(errorCalls[0]).toContain("Test error message");
    
    // Should exit with a non-zero status code
    expect(exitCode).toBe(1);
  });

  it("prevents creating a session when already in a session workspace", async () => {
    // Arrange
    const command = createStartCommand();
    
    // Mock isSessionRepository to return true
    mockIsSessionRepository.mockImplementationOnce(() => true);
    
    // Track process.exit calls
    let exitCode = 0;
    process.exit = (code = 0) => {
      exitCode = code;
      return undefined as never;
    };
    
    // Act - execute the command
    await command.parseAsync(["node", "test", "test-session", "--repo", "/path/to/repo"]);
    
    // Assert
    // Should log the error about being in a session already
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0]).toContain("Error starting session:");
    expect(errorCalls[0]).toContain("Cannot create a new session while inside a session workspace");
    
    // Should not call startSession
    expect(mockStartSession.mock.calls.length).toBe(0);
    
    // Should exit with non-zero status code
    expect(exitCode).toBe(1);
  });
}); 
