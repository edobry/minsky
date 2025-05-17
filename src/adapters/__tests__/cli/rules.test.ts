import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import * as path from "path";
import { createMock, mockModule, setupTestMocks } from "../../../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

// Mock dependencies
const mockResolveWorkspacePath = createMock(() => Promise.resolve("/mock/workspace"));
const mockRuleService = {
  createRule: createMock(() =>
    Promise.resolve({ id: "test-rule", path: "/mock/workspace/.cursor/rules/test-rule.mdc" })
  ),
  updateRule: createMock(() =>
    Promise.resolve({ id: "test-rule", path: "/mock/workspace/.cursor/rules/test-rule.mdc" })
  ),
};

// Create a realistic temp directory for file tests
const testDir = path.join(process.cwd(), "test-tmp", `rules-cli-test-${Date.now()}`);
const testFilePath = path.join(testDir, "test-content.md");
const testGlobsFilePath = path.join(testDir, "test-globs.json");

// Mock modules using the centralized utilities
mockModule("../../../domain/workspace.js", () => ({
  resolveWorkspacePath: mockResolveWorkspacePath,
}));

mockModule("../../../domain/rules.js", () => ({
  RuleService: class {
    constructor() {
      return mockRuleService;
    }
  },
}));

// Re-import the rules module after mocking dependencies
// Use correct relative path from the test location to the rules.ts file
import { createRulesCommand, createCreateCommand, createUpdateCommand } from "../../cli/rules.js";

describe("Rules CLI Commands", () => {
  beforeEach(async () => {
    // Reset mocks
    mockResolveWorkspacePath.mockClear();
    mockRuleService.createRule.mockClear();
    mockRuleService.updateRule.mockClear();

    // Create test directory and files
    await fs.mkdir(testDir, { recursive: true });

    // Create a test content file
    await fs.writeFile(testFilePath, "# Test Rule Content\n\nThis is test content.");

    // Create a test globs file
    await fs.writeFile(testGlobsFilePath, '["**/*.ts", "**/*.tsx"]');
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("createCreateCommand", () => {
    test("reads content from file when --content points to a file", async () => {
      // Mock console.log to capture output
      const originalConsoleLog = console.log;
      const mockConsoleLog = createMock(() => {});
      console.log = mockConsoleLog;

      // Create a mock commander program
      const program = createCreateCommand();

      // Generate command arguments
      const args = ["test-rule", "--content", testFilePath];

      // Parse the arguments
      await program.parseAsync(["node", "test", ...args]);

      // Verify that createRule was called with the file content
      expect(mockRuleService.createRule).toHaveBeenCalledWith("test-rule", "# Test Rule Content\n\nThis is test content.", {}, {});
      
      const createRuleArgs = mockRuleService.createRule.mock.calls[0];
      expect(createRuleArgs[0]).toBe("test-rule");
      expect(createRuleArgs[1]).toBe("# Test Rule Content\n\nThis is test content.");

      // Restore console.log
      console.log = originalConsoleLog;
    });

    test("handles different glob formats (comma-separated string)", async () => {
      // Mock console.log
      const originalConsoleLog = console.log;
      console.log = createMock(() => {});

      // Create command
      const program = createCreateCommand();

      // Generate command arguments with comma-separated globs
      const args = ["test-rule", "--globs", "**/*.ts,**/*.tsx"];

      // Parse the arguments
      await program.parseAsync(["node", "test", ...args]);

      // Check the actual arguments that were passed
      const createRuleArgs = mockRuleService.createRule.mock.calls[0];
      expect(createRuleArgs[2].globs).toEqual(["**/*.ts", "**/*.tsx"]);
      
      // Restore console.log
      console.log = originalConsoleLog;
    });

    test("handles different glob formats (JSON array string)", async () => {
      // Mock console.log
      const originalConsoleLog = console.log;
      console.log = createMock(() => {});

      // Create command
      const program = createCreateCommand();

      // Generate command arguments with JSON array string
      const args = ["test-rule", "--globs", '["**/*.ts", "**/*.tsx"]'];

      // Parse the arguments
      await program.parseAsync(["node", "test", ...args]);

      // Check the actual arguments that were passed
      const createRuleArgs = mockRuleService.createRule.mock.calls[0];
      expect(createRuleArgs[2].globs).toEqual(["**/*.ts", "**/*.tsx"]);
      
      // Restore console.log
      console.log = originalConsoleLog;
    });
  });

  describe("createUpdateCommand", () => {
    test("reads content from file when --content points to a file", async () => {
      // Mock console.log
      const originalConsoleLog = console.log;
      console.log = createMock(() => {});

      // Create command
      const program = createUpdateCommand();

      // Generate command arguments
      const args = ["test-rule", "--content", testFilePath];

      // Parse the arguments
      await program.parseAsync(["node", "test", ...args]);

      // Check the actual arguments that were passed
      const updateRuleArgs = mockRuleService.updateRule.mock.calls[0];
      expect(updateRuleArgs[0]).toBe("test-rule");
      expect(updateRuleArgs[1].content).toBe("# Test Rule Content\n\nThis is test content.");
      
      // Restore console.log
      console.log = originalConsoleLog;
    });

    test("handles different glob formats (comma-separated string)", async () => {
      // Mock console.log
      const originalConsoleLog = console.log;
      console.log = createMock(() => {});

      // Create command
      const program = createUpdateCommand();

      // Generate command arguments with comma-separated globs
      const args = ["test-rule", "--globs", "**/*.ts,**/*.tsx"];

      // Parse the arguments
      await program.parseAsync(["node", "test", ...args]);

      // Check the actual arguments that were passed
      const updateRuleArgs = mockRuleService.updateRule.mock.calls[0];
      expect(updateRuleArgs[1].meta.globs).toEqual(["**/*.ts", "**/*.tsx"]);
      
      // Restore console.log
      console.log = originalConsoleLog;
    });

    test("handles different glob formats (JSON array string)", async () => {
      // Mock console.log
      const originalConsoleLog = console.log;
      console.log = createMock(() => {});

      // Create command
      const program = createUpdateCommand();

      // Generate command arguments with JSON array string
      const args = ["test-rule", "--globs", '["**/*.ts", "**/*.tsx"]'];

      // Parse the arguments
      await program.parseAsync(["node", "test", ...args]);

      // Check the actual arguments that were passed
      const updateRuleArgs = mockRuleService.updateRule.mock.calls[0];
      expect(updateRuleArgs[1].meta.globs).toEqual(["**/*.ts", "**/*.tsx"]);
      
      // Restore console.log
      console.log = originalConsoleLog;
    });
  });
}); 
