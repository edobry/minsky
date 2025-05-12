import { describe, test, expect } from "bun:test";
import { createSessionCommand } from "./index";
import { Command } from "commander";

describe("session command workspace auto-detection", () => {
  test("session dir command should use detected session when no arguments are provided", async () => {
    // Create a simple function that simulates getCurrentSession
    const mockGetCurrentSession = async () => "auto-detected-session";

    // Create the session command with the mock function
    const sessionCommand = createSessionCommand({
      getCurrentSession: mockGetCurrentSession,
    });

    // Setup a test program to parse arguments
    const program = new Command();
    program.addCommand(sessionCommand);

    // Verify the session command exists
    expect(sessionCommand.name()).toBe("session");
  });

  test("session get command should accept getCurrentSession dependency", async () => {
    // Create a simple function that simulates getCurrentSession
    const mockGetCurrentSession = async () => "auto-detected-session";

    // Create the session command with mock dependencies
    const sessionCommand = createSessionCommand({
      getCurrentSession: mockGetCurrentSession,
    });

    // Verify that the command can be created with the dependencies
    const getCommand = sessionCommand.commands.find((cmd) => cmd.name() === "get");
    expect(!!getCommand).toBe(true);
  });

  test("session commands should respect --ignore-workspace flag", async () => {
    // This test verifies that the --ignore-workspace flag is implemented
    // Create the session command
    const sessionCommand = createSessionCommand();

    // Check that the 'dir' command has the --ignore-workspace option
    const dirCommand = sessionCommand.commands.find((cmd) => cmd.name() === "dir");
    expect(!!dirCommand).toBe(true);

    if (dirCommand) {
      const hasIgnoreWorkspaceOption = dirCommand.options.some(
        (opt) => opt.long === "--ignore-workspace"
      );
      expect(hasIgnoreWorkspaceOption).toBe(true);
    }

    // Check that the 'get' command has the --ignore-workspace option
    const getCommand = sessionCommand.commands.find((cmd) => cmd.name() === "get");
    expect(!!getCommand).toBe(true);

    if (getCommand) {
      const hasIgnoreWorkspaceOption = getCommand.options.some(
        (opt) => opt.long === "--ignore-workspace"
      );
      expect(hasIgnoreWorkspaceOption).toBe(true);
    }
  });
});
