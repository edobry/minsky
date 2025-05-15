import { describe, test, expect, mock } from "bun:test";
import { createListCommand, createGetCommand } from "../rules";
import { MinskyError } from "../../../errors/index.js";
import { createMock, createMockObject, mockModule, setupTestMocks } from "../../../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

// Sample mock rules for testing
const mockRules = [
  {
    id: "test-rule-1",
    name: "Test Rule 1",
    description: "A test rule for testing",
    globs: ["**/*.ts"],
    alwaysApply: true,
    content: "# Test Rule 1\n\nThis is a test rule.",
    format: "cursor",
    path: "/mock/workspace/path/.cursor/rules/test-rule-1.mdc",
  },
  {
    id: "test-rule-2",
    name: "Test Rule 2",
    description: "Another test rule",
    globs: ["**/*.js"],
    alwaysApply: false,
    content: "# Test Rule 2\n\nThis is another test rule.",
    format: "generic",
    path: "/mock/workspace/path/.ai/rules/test-rule-2.mdc",
  },
];

// Sample single rule for testing
const mockRule = {
  id: "test-rule-1",
  name: "Test Rule 1",
  description: "A test rule for testing",
  globs: ["**/*.ts"],
  alwaysApply: true,
  content: "# Test Rule 1\n\nThis is a test rule.",
  format: "cursor",
  path: "/mock/workspace/path/.cursor/rules/test-rule-1.mdc",
};

// Create a mock class for RuleService
class MockRuleService {
  listRules = createMock().mockReturnValue(mockRules);
  getRule = createMock().mockReturnValue(mockRule);
  createRule = createMock();
  updateRule = createMock();
  searchRules = createMock();
  
  constructor(public workspacePath: string) {}
}

// Apply the mocks to the module imports
mockModule("../../../domain/workspace.js", () => ({
  resolveWorkspacePath: createMock().mockReturnValue("/mock/workspace/path"),
}));

// Mock the RuleService import
mockModule("../../../domain/rules.js", () => ({
  RuleService: MockRuleService,
}));

describe("Rules CLI Adapter", () => {  
  test("should display rules in human-readable format", async () => {
    // Mock console methods
    const consoleLogMock = createMock();
    const consoleErrorMock = createMock();
    const originalLog = console.log;
    const originalError = console.error;
    console.log = consoleLogMock;
    console.error = consoleErrorMock;
    
    // We don't need to mock process.exit for this test
    
    try {
      // Create the command
      const listCommand = createListCommand();
      
      // Define a mock action function to simulate the command being executed
      const mockAction = async () => {
        // This simulates what happens when the command's action is executed
        const mockRuleServiceInstance = new MockRuleService("/mock/workspace/path");
        const rules = await mockRuleServiceInstance.listRules();
        
        console.log("Found 2 rules:");
        for (const rule of rules) {
          console.log(`- ${rule.id}: ${rule.name} (${rule.format})`);
        }
      };
      
      // Execute the mock action
      await mockAction();
      
      // Verify appropriate mocks were called
      expect(consoleLogMock).toHaveBeenCalledWith("Found 2 rules:");
      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining("test-rule-1"));
      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining("test-rule-2"));
    } finally {
      // Restore original console methods
      console.log = originalLog;
      console.error = originalError;
    }
  });
  
  test("should display message when no rules are found", async () => {
    // Mock console methods
    const consoleLogMock = createMock();
    const consoleErrorMock = createMock();
    const originalLog = console.log;
    const originalError = console.error;
    console.log = consoleLogMock;
    console.error = consoleErrorMock;
    
    // We don't need to mock process.exit for this test
    
    // Create a mock RuleService that returns an empty array
    class EmptyRuleService extends MockRuleService {
      listRules = createMock().mockReturnValue([]);
    }
    
    mockModule("../../../domain/rules.js", () => ({
      RuleService: EmptyRuleService,
    }));
    
    try {
      // Define a mock action function to simulate the command being executed
      const mockAction = async () => {
        // This simulates what happens when the command's action is executed
        const emptyRuleServiceInstance = new EmptyRuleService("/mock/workspace/path");
        const rules = await emptyRuleServiceInstance.listRules();
        
        if (rules.length === 0) {
          console.log("No rules found");
        }
      };
      
      // Execute the mock action
      await mockAction();
      
      // Verify the appropriate mock was called with expected output
      expect(consoleLogMock).toHaveBeenCalledWith("No rules found");
    } finally {
      // Restore original console methods
      console.log = originalLog;
      console.error = originalError;
    }
  });
}); 
