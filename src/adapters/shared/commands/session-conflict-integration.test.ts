/**
 * Tests for Session Conflict Detection CLI Integration
 * 
 * Verifies that the new conflict handling parameters are properly
 * integrated into the session commands and passed through correctly.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { registerSessionCommands } from "./session.js";
import { sharedCommandRegistry, CommandCategory } from "../../shared/command-registry.js";

// Mock the session domain functions
const mockUpdateSessionFromParams = mock(() => Promise.resolve({
  session: "test-session",
  repoName: "test-repo",
  repoUrl: "https://github.com/test/repo",
  branch: "test-branch",
  createdAt: new Date().toISOString(),
  taskId: "123",
  repoPath: "/mock/session/workdir",
}));

const mockSessionPrFromParams = mock(() => Promise.resolve({
  prBranch: "pr/test-branch",
  baseBranch: "main",
  title: "Test PR",
  body: "Test PR body",
}));

// Mock the domain module
mock.module("../../../domain/session.js", () => ({
  updateSessionFromParams: mockUpdateSessionFromParams,
  sessionPrFromParams: mockSessionPrFromParams,
  listSessionsFromParams: mock(() => Promise.resolve([])),
  getSessionFromParams: mock(() => Promise.resolve(null)),
  startSessionFromParams: mock(() => Promise.resolve({})),
  deleteSessionFromParams: mock(() => Promise.resolve(true)),
  getSessionDirFromParams: mock(() => Promise.resolve("/test/dir")),
  approveSessionFromParams: mock(() => Promise.resolve({})),
  inspectSessionFromParams: mock(() => Promise.resolve(null)),
}));

describe("Session Conflict Detection CLI Integration", () => {
  
  beforeEach(() => {
    // Clear the registry and reset mocks
    (sharedCommandRegistry as any)?.commands = new Map();
    mockUpdateSessionFromParams.mockClear();
    mockSessionPrFromParams.mockClear();
  });

  it("should pass conflict detection parameters to session update command", async () => {
    // Register commands
    registerSessionCommands();
    
    // Get the update command
    const updateCommand = sharedCommandRegistry.getCommand("session.update");
    expect(updateCommand).toBeDefined();
    
    // Execute with conflict handling parameters
    const params = {
      name: "test-session",
      skipConflictCheck: true,
      autoResolveDeleteConflicts: true,
      dryRun: true,
      skipIfAlreadyMerged: true,
      force: false,
      noStash: false,
      noPush: false,
      json: false,
    };
    
    const context = { interface: "test" };
    await updateCommand!.execute(params);
    
    // Verify the domain function was called with conflict parameters
    expect(mockUpdateSessionFromParams).toHaveBeenCalledWith({
      name: "test-session",
      task: undefined,
      repo: undefined,
      branch: undefined,
      noStash: false,
      noPush: false,
      force: false,
      json: false,
      skipConflictCheck: true,
      autoResolveDeleteConflicts: true,
      dryRun: true,
      skipIfAlreadyMerged: true,
    });
  });

  it("should pass conflict detection parameters to session PR command", async () => {
    // Register commands
    registerSessionCommands();
    
    // Get the PR command
    const prCommand = sharedCommandRegistry.getCommand("session.pr");
    expect(prCommand).toBeDefined();
    
    // Execute with conflict handling parameters
    const params = {
      title: "Test PR",
      body: "Test PR body",
      name: "test-session",
      autoResolveDeleteConflicts: true,
      skipConflictCheck: true,
      skipUpdate: false,
      noStatusUpdate: false,
      debug: false,
      json: false,
    };
    
    const context = { interface: "test" };
    await prCommand!.execute(params);
    
    // Verify the domain function was called with conflict parameters
    expect(mockSessionPrFromParams).toHaveBeenCalledWith({
      title: "Test PR",
      body: "Test PR body",
      bodyPath: undefined,
      session: "test-session",
      task: undefined,
      repo: undefined,
      noStatusUpdate: false,
      debug: false,
      skipUpdate: false,
      autoResolveDeleteConflicts: true,
      skipConflictCheck: true,
    });
  });

  it("should have correct parameter schemas for conflict detection options", () => {
    // Register commands
    registerSessionCommands();
    
    // Check session update command parameters
    const updateCommand = sharedCommandRegistry.getCommand("session.update");
    expect(updateCommand).toBeDefined();
    expect(updateCommand!.parameters.skipConflictCheck).toBeDefined();
    expect(updateCommand!.parameters.autoResolveDeleteConflicts).toBeDefined();
    expect(updateCommand!.parameters.dryRun).toBeDefined();
    expect(updateCommand!.parameters.skipIfAlreadyMerged).toBeDefined();
    
    // Check parameter descriptions
    expect(updateCommand!.parameters.skipConflictCheck.description).toContain("proactive conflict detection");
    expect(updateCommand!.parameters.autoResolveDeleteConflicts.description).toContain("delete/modify conflicts");
    expect(updateCommand!.parameters.dryRun.description).toContain("Check for conflicts without performing");
    expect(updateCommand!.parameters.skipIfAlreadyMerged.description).toContain("already in base branch");
    
    // Check session PR command parameters
    const prCommand = sharedCommandRegistry.getCommand("session.pr");
    expect(prCommand).toBeDefined();
    expect(prCommand!.parameters.autoResolveDeleteConflicts).toBeDefined();
    expect(prCommand!.parameters.skipConflictCheck).toBeDefined();
    
    // Check parameter descriptions
    expect(prCommand!.parameters.autoResolveDeleteConflicts.description).toContain("delete/modify conflicts");
    expect(prCommand!.parameters.skipConflictCheck.description).toContain("proactive conflict detection");
  });

  it("should use default values for conflict detection parameters", async () => {
    // Register commands
    registerSessionCommands();
    
    // Get the update command
    const updateCommand = sharedCommandRegistry.getCommand("session.update");
    expect(updateCommand).toBeDefined();
    
    // Execute with minimal parameters (should use defaults)
    const params = {
      name: "test-session",
      force: false,
      noStash: false,
      noPush: false,
      json: false,
    };
    
    const context = { interface: "test" };
    await updateCommand!.execute(params);
    
    // Verify the domain function was called with default conflict parameters
    expect(mockUpdateSessionFromParams).toHaveBeenCalledWith({
      name: "test-session",
      task: undefined,
      repo: undefined,
      branch: undefined,
      noStash: false,
      noPush: false,
      force: false,
      json: false,
      skipConflictCheck: undefined, // Will use schema default (false)
      autoResolveDeleteConflicts: undefined, // Will use schema default (false)
      dryRun: undefined, // Will use schema default (false)
      skipIfAlreadyMerged: undefined, // Will use schema default (false)
    });
  });

  it("should handle mixed conflict detection parameter combinations", async () => {
    // Register commands
    registerSessionCommands();
    
    // Get the update command
    const updateCommand = sharedCommandRegistry.getCommand("session.update");
    expect(updateCommand).toBeDefined();
    
    // Execute with mixed parameters
    const params = {
      name: "test-session", 
      autoResolveDeleteConflicts: true, // Enable auto-resolve
      skipConflictCheck: false, // Keep conflict checking
      dryRun: false, // Perform actual update
      skipIfAlreadyMerged: true, // Skip if already merged
      force: false,
      noStash: true,
      noPush: false,
      json: false,
    };
    
    const context = { interface: "test" };
    await updateCommand!.execute(params);
    
    // Verify the specific combination was passed through correctly
    expect(mockUpdateSessionFromParams).toHaveBeenCalledWith(
      expect.objectContaining({
        autoResolveDeleteConflicts: true,
        skipConflictCheck: false,
        dryRun: false,
        skipIfAlreadyMerged: true,
      })
    );
  });
}); 
