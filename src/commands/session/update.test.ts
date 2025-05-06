import { describe, test, expect } from "bun:test";
import { createUpdateCommand } from "./update";
import { GitService } from "../../domain/git";
import { SessionDB } from "../../domain/session";

describe("session update command", () => {
  test("command can be created", () => {
    // Create simple mock implementations
    const mockGitService = {} as GitService;
    const mockSessionDb = {} as SessionDB;

    // Create command with mocked dependencies
    const command = createUpdateCommand(mockGitService, mockSessionDb);
    
    // Verify the command was created successfully
    expect(command).toBeDefined();
    expect(command.name()).toBe("update");
    expect(command.description()).toContain("session");
  });
});
