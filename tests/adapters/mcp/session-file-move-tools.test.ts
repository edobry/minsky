/**
 * Tests for session-aware file move and rename tools
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("Session File Move Tools Integration", () => {
  let tempDir: string;
  let sessionDir: string;
  let testFilePath: string;
  let testTargetPath: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = join(tmpdir(), `session-move-test-${Date.now()}`);
    sessionDir = join(tempDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    // Create test files
    testFilePath = join(sessionDir, "test-file.txt");
    testTargetPath = join(sessionDir, "target-file.txt");
    writeFileSync(testFilePath, "test content");
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("session file tools can be imported without errors", async () => {
    // Test that we can import the module
    const sessionFileModule = await import("../../../src/adapters/mcp/session-files");
    expect(sessionFileModule.registerSessionFileTools).toBeDefined();
    expect(sessionFileModule.SessionPathResolver).toBeDefined();
  });

  test("registerSessionFileTools registers move and rename commands", async () => {
    const sessionFileModule = await import("../../../src/adapters/mcp/session-files");

    const registeredCommands: any[] = [];
    const mockCommandMapper = {
      addCommand: mock((command: any) => {
        registeredCommands.push(command);
      }),
    };

    // Register the tools
    sessionFileModule.registerSessionFileTools(mockCommandMapper);

    // Check that our new commands were registered
    const commandNames = registeredCommands.map((cmd) => cmd.name);
    expect(commandNames).toContain("session.move_file");
    expect(commandNames).toContain("session.rename_file");

    // Verify the move file command has correct structure
    const moveCommand = registeredCommands.find((cmd) => cmd.name === "session.move_file");
    expect(moveCommand).toBeDefined();
    expect(moveCommand.description).toContain("Move a file");
    expect(moveCommand.handler).toBeDefined();
    expect(typeof moveCommand.handler).toBe("function");

    // Verify the rename file command has correct structure
    const renameCommand = registeredCommands.find((cmd) => cmd.name === "session.rename_file");
    expect(renameCommand).toBeDefined();
    expect(renameCommand.description).toContain("Rename a file");
    expect(renameCommand.handler).toBeDefined();
    expect(typeof renameCommand.handler).toBe("function");
  });

  test("command parameters validation works correctly", async () => {
    const sessionFileModule = await import("../../../src/adapters/mcp/session-files");

    const registeredCommands: any[] = [];
    const mockCommandMapper = {
      addCommand: mock((command: any) => {
        registeredCommands.push(command);
      }),
    };

    sessionFileModule.registerSessionFileTools(mockCommandMapper);

    // Test session_move_file parameters
    const moveCommand = registeredCommands.find((cmd) => cmd.name === "session.move_file");
    const moveSchema = moveCommand.parameters;

    const validMoveData = {
      sessionName: "test-session",
      sourcePath: "source.txt",
      targetPath: "target.txt",
      createDirs: true,
      overwrite: false,
    };

    const moveResult = moveSchema.safeParse(validMoveData);
    expect(moveResult.success).toBe(true);

    // Test session_rename_file parameters
    const renameCommand = registeredCommands.find((cmd) => cmd.name === "session.rename_file");
    const renameSchema = renameCommand.parameters;

    const validRenameData = {
      sessionName: "test-session",
      path: "oldname.txt",
      newName: "newname.txt",
      overwrite: false,
    };

    const renameResult = renameSchema.safeParse(validRenameData);
    expect(renameResult.success).toBe(true);
  });

  test("parameter validation rejects invalid data", async () => {
    const sessionFileModule = await import("../../../src/adapters/mcp/session-files");

    const registeredCommands: any[] = [];
    const mockCommandMapper = {
      addCommand: mock((command: any) => {
        registeredCommands.push(command);
      }),
    };

    sessionFileModule.registerSessionFileTools(mockCommandMapper);

    // Test invalid move command parameters (missing required fields)
    const moveCommand = registeredCommands.find((cmd) => cmd.name === "session.move_file");
    const moveSchema = moveCommand.parameters;

    const invalidMoveData = {
      sessionName: "test-session",
      // Missing sourcePath and targetPath
    };

    const moveResult = moveSchema.safeParse(invalidMoveData);
    expect(moveResult.success).toBe(false);

    // Test invalid rename command parameters (missing required fields)
    const renameCommand = registeredCommands.find((cmd) => cmd.name === "session.rename_file");
    const renameSchema = renameCommand.parameters;

    const invalidRenameData = {
      sessionName: "test-session",
      // Missing path and newName
    };

    const renameResult = renameSchema.safeParse(invalidRenameData);
    expect(renameResult.success).toBe(false);
  });

  test("default parameter values are set correctly", async () => {
    const sessionFileModule = await import("../../../src/adapters/mcp/session-files");

    const registeredCommands: any[] = [];
    const mockCommandMapper = {
      addCommand: mock((command: any) => {
        registeredCommands.push(command);
      }),
    };

    sessionFileModule.registerSessionFileTools(mockCommandMapper);

    // Test session_move_file default values
    const moveCommand = registeredCommands.find((cmd) => cmd.name === "session.move_file");
    const moveSchema = moveCommand.parameters;

    const moveDataWithDefaults = {
      sessionName: "test-session",
      sourcePath: "source.txt",
      targetPath: "target.txt",
      // createDirs and overwrite should default to true and false respectively
    };

    const moveResult = moveSchema.parse(moveDataWithDefaults);
    expect(moveResult.createDirs).toBe(true);
    expect(moveResult.overwrite).toBe(false);

    // Test session_rename_file default values
    const renameCommand = registeredCommands.find((cmd) => cmd.name === "session.rename_file");
    const renameSchema = renameCommand.parameters;

    const renameDataWithDefaults = {
      sessionName: "test-session",
      path: "oldname.txt",
      newName: "newname.txt",
      // overwrite should default to false
    };

    const renameResult = renameSchema.parse(renameDataWithDefaults);
    expect(renameResult.overwrite).toBe(false);
  });

  test("tools are properly exported from module", async () => {
    const sessionFileModule = await import("../../../src/adapters/mcp/session-files");

    // Check that the function and class are properly exported
    expect(typeof sessionFileModule.registerSessionFileTools).toBe("function");
    expect(typeof sessionFileModule.SessionPathResolver).toBe("function");
  });

  test("SessionPathResolver can be instantiated", async () => {
    const { SessionPathResolver } = await import("../../../src/adapters/mcp/session-files");

    // Should be able to create an instance
    const pathResolver = new SessionPathResolver();
    expect(pathResolver).toBeDefined();
    expect(typeof pathResolver.resolvePath).toBe("function");
    expect(typeof pathResolver.validatePathExists).toBe("function");
    // getSessionWorkspacePath is not exposed as a public method
  });
});
