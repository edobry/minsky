/**
 * Shared Command CLI Integration Tests
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import createIntegratedCliProgram from "../../../adapters/cli/integration-example.js";
import {
  sharedCommandRegistry,
} from "../../../adapters/shared/command-registry.js";
import * as gitCommands from "../../../adapters/shared/commands/git.js";

describe("Shared Command CLI Integration", () => {
  let registerGitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Clear the global registry to prevent registration conflicts
    sharedCommandRegistry.clear();

    // Set up spy
    registerGitSpy = spyOn(gitCommands, "registerGitCommands");
  });

  test("createIntegratedCliProgram should create a CLI program with shared commands", () => {
    // Create the program
    const program = createIntegratedCliProgram();

    // Verify the program was created
    expect(program).toBeDefined();
    expect(program.name()).toBe("minsky");

    // Verify the git command registration function was called
    expect(registerGitSpy).toHaveBeenCalledWith();
  });

  test("CLI program should have git subcommand registered", () => {
    // Create the program
    const program = createIntegratedCliProgram();

    // Find the git subcommand
    const gitCommand = program.commands.find((cmd) => cmd.name() === "git");

    // Verify the git subcommand exists
    expect(gitCommand).toBeDefined();
  });
});
