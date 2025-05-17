import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import * as path from "path";
import { createMock, mockModule, setupTestMocks } from "../../../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

// Define a type for mock call arguments to help with type checking
type MockCallArgs = unknown[];

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

      // Verify that createRule was called correctly using toHaveBeenCalledWith
      expect(mockRuleService.createRule).toHaveBeenCalledWith("test-rule", "# Test Rule Content\n\nThis is test content.", {}, {});
      
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

      // Check that we have at least one call
      const calls = mockRuleService.createRule.mock.calls as MockCallArgs[];
      expect(calls.length).toBeGreaterThan(0);
      
      // If we have calls, check the arguments (with type safe access)
      if (calls.length > 0) {
        const thirdArg = calls[0][2] as { globs?: string[] };
        expect(thirdArg?.globs).toEqual(["**/*.ts", "**/*.tsx"]);
      }
      
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

      // Check that we have at least one call
      const calls = mockRuleService.createRule.mock.calls as MockCallArgs[];
      expect(calls.length).toBeGreaterThan(0);
      
      // If we have calls, check the arguments (with type safe access)
      if (calls.length > 0) {
        const thirdArg = calls[0][2] as { globs?: string[] };
        expect(thirdArg?.globs).toEqual(["**/*.ts", "**/*.tsx"]);
      }
      
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

      // Check that we have at least one call
      const calls = mockRuleService.updateRule.mock.calls as MockCallArgs[];
      expect(calls.length).toBeGreaterThan(0);
      
      // If we have calls, check the arguments (with type safe access)
      if (calls.length > 0) {
        expect(calls[0][0]).toBe("test-rule");
        const secondArg = calls[0][1] as { content?: string };
        expect(secondArg?.content).toBe("# Test Rule Content\n\nThis is test content.");
      }
      
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

      // Check that we have at least one call
      const calls = mockRuleService.updateRule.mock.calls as MockCallArgs[];
      expect(calls.length).toBeGreaterThan(0);
      
      // If we have calls, check the arguments (with type safe access)
      if (calls.length > 0) {
        const secondArg = calls[0][1] as { meta?: { globs?: string[] } };
        expect(secondArg?.meta?.globs).toEqual(["**/*.ts", "**/*.tsx"]);
      }
      
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

      // Check that we have at least one call
      const calls = mockRuleService.updateRule.mock.calls as MockCallArgs[];
      expect(calls.length).toBeGreaterThan(0);
      
      // If we have calls, check the arguments (with type safe access)
      if (calls.length > 0) {
        const secondArg = calls[0][1] as { meta?: { globs?: string[] } };
        expect(secondArg?.meta?.globs).toEqual(["**/*.ts", "**/*.tsx"]);
      }
      
      // Restore console.log
      console.log = originalConsoleLog;
    });
  });
}); 
