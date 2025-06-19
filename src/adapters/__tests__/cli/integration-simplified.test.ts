/**
 * Simplified CLI Integration Tests
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  sharedCommandRegistry,
  CommandCategory,
} from "../../../adapters/shared/command-registry.js";
import { registerGitCommands } from "../../../adapters/shared/commands/git";

describe("Shared Command CLI Integration", () => {
  beforeEach(() => {
    // Clear the registry
    (sharedCommandRegistry as any).commands = new Map();
  });

  test("sharedCommandRegistry should contain git commands after registration", () => {
    // Register commands
    registerGitCommands();

    // Verify commands were registered
    const gitCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.GIT);
    expect(gitCommands.length).toBe(5);

    // Verify commit command
    const commitCommand = sharedCommandRegistry.getCommand("git.commit");
    expect(commitCommand).toBeDefined();
    expect(commitCommand?.name).toBe("commit");
    expect(commitCommand?.description).toBe("Commit changes to the repository");
    expect(commitCommand?.parameters?.message).toBeDefined();
    expect(commitCommand?.parameters?.message?.required).toBe(true);

    // Verify push command
    const pushCommand = sharedCommandRegistry.getCommand("git.push");
    expect(pushCommand).toBeDefined();
    expect(pushCommand?.name).toBe("push");
    expect(pushCommand?.description).toBe("Push changes to the remote repository");
  });
});
