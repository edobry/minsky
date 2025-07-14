import { describe, it, expect, beforeEach, mock } from "bun:test";
import { registerSessionCommands } from "./session.js";
import { sharedCommandRegistry } from "../command-registry.js";

describe("Session PR Command Conditional Validation Bug", () => {
  let mockGitService: any;
  let mockContext: any;

  beforeEach(() => {
    // Reset the command registry
    sharedCommandRegistry.clear();
    registerSessionCommands();

    // Mock git service
    mockGitService = {
      execInRepository: mock(() => Promise.resolve("")),
    };

    // Mock context
    mockContext = {
      outputFormat: "text",
      debug: false,
    };

    // Mock the git service import
    mock.module("../../../domain/git.js", () => ({
      createGitService: () => mockGitService,
    }));
  });

  describe("Bug: Session PR requiring body/bodyPath for existing PR refresh", () => {
    it("should allow refresh of existing PR without body/bodyPath parameters", async () => {
      // Bug reproduction setup: Existing PR branch exists
      mockGitService.execInRepository = mock()
        .mockResolvedValueOnce("") // Local branch check succeeds (empty means exists)
        .mockResolvedValueOnce("origin/pr/task#270 abc123"); // Remote branch exists

      // Mock process.cwd to return session workspace path
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/Users/edobry/.local/state/minsky/sessions/task#270");

      try {
        const command = sharedCommandRegistry.getCommand("session.pr");
        
        // This should NOT throw an error for existing PR refresh
        // Before the fix, this would have thrown: "PR description is required"
        await expect(async () => {
          await command!.execute({
            name: "task#270",
            // No body or bodyPath - should work for existing PR
          }, mockContext);
        }).not.toThrow();

      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should require body/bodyPath for new PR creation", async () => {
      // Setup: No existing PR branch
      mockGitService.execInRepository = mock()
        .mockResolvedValueOnce("not-exists") // Local branch doesn't exist
        .mockResolvedValueOnce(""); // Remote branch doesn't exist

      // Mock process.cwd to return session workspace path
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/Users/edobry/.local/state/minsky/sessions/task#270");

      try {
        const command = sharedCommandRegistry.getCommand("session.pr");
        
        // This SHOULD throw an error for new PR without body/bodyPath
        await expect(command!.execute({
          name: "new-session",
          // No body or bodyPath - should fail for new PR
        }, mockContext)).rejects.toThrow("PR description is required for meaningful pull requests");

      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should allow update of existing PR with new title/body", async () => {
      // Setup: Existing PR branch exists
      mockGitService.execInRepository = mock()
        .mockResolvedValueOnce("") // Local branch exists
        .mockResolvedValueOnce("origin/pr/task#270 abc123"); // Remote branch exists

      // Mock process.cwd to return session workspace path
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/Users/edobry/.local/state/minsky/sessions/task#270");

      try {
        const command = sharedCommandRegistry.getCommand("session.pr");
        
        // This should work - updating existing PR with new content
        await expect(command!.execute({
          name: "task#270",
          title: "Updated Title",
          body: "Updated body content",
        }, mockContext)).resolves.not.toThrow();

      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should handle session name detection from current directory", async () => {
      // Setup: Existing PR branch exists
      mockGitService.execInRepository = mock()
        .mockResolvedValueOnce("") // Local branch exists
        .mockResolvedValueOnce("origin/pr/task#270 abc123"); // Remote branch exists

      // Mock process.cwd to return session workspace path without explicit name
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/Users/edobry/.local/state/minsky/sessions/task#270");

      try {
        const command = sharedCommandRegistry.getCommand("session.pr");
        
        // Should detect session name from directory and allow refresh
        await expect(command!.execute({
          // No explicit session name - should detect from directory
        }, mockContext)).resolves.not.toThrow();

      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should handle git service errors gracefully", async () => {
      // Setup: Git service throws error
      mockGitService.execInRepository = mock(() => Promise.reject(new Error("Git error")));

      // Mock process.cwd to return session workspace path
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/Users/edobry/.local/state/minsky/sessions/task#270");

      try {
        const command = sharedCommandRegistry.getCommand("session.pr");
        
        // Should assume no PR exists and require body/bodyPath
        await expect(command!.execute({
          name: "task#270",
          // No body or bodyPath
        }, mockContext)).rejects.toThrow("PR description is required for meaningful pull requests");

      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle non-session workspace directories", async () => {
      // Mock process.cwd to return non-session path
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/Users/edobry/regular-directory");

      try {
        const command = sharedCommandRegistry.getCommand("session.pr");
        
        // Should require body/bodyPath when not in session workspace
        await expect(command!.execute({
          // No session name or body/bodyPath
        }, mockContext)).rejects.toThrow("PR description is required for meaningful pull requests");

      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should handle empty session name detection", async () => {
      // Mock process.cwd to return malformed session path
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/Users/edobry/.local/state/minsky/sessions/");

      try {
        const command = sharedCommandRegistry.getCommand("session.pr");
        
        // Should require body/bodyPath when session name can't be detected
        await expect(command!.execute({
          // No session name and path doesn't contain valid session
        }, mockContext)).rejects.toThrow("PR description is required for meaningful pull requests");

      } finally {
        process.cwd = originalCwd;
      }
    });
  });
}); 
