import { describe, test, expect, mock } from "bun:test";
import { createListCommand, createGetCommand } from "../rules";
import { MinskyError } from "../../../errors/index.js";

// Helper to create a mock function
function createMockFunction() {
  const calls: any[][] = [];
  const fn = (...args: any[]) => {
    calls.push(args);
    if (typeof fn.implementation === 'function') {
      return fn.implementation(...args);
    }
    return fn.returnValue;
  };
  
  fn.calls = calls;
  fn.returnValue = undefined;
  fn.implementation = undefined as any;
  
  fn.mockReturnValue = (val: any) => {
    fn.returnValue = val;
    return fn;
  };
  
  fn.mockImplementation = (impl: Function) => {
    fn.implementation = impl;
    return fn;
  };
  
  fn.mockReset = () => {
    calls.length = 0;
    fn.returnValue = undefined;
    fn.implementation = undefined;
  };
  
  return fn;
}

// Mock the resolveWorkspacePath function
const mockResolveWorkspacePath = createMockFunction();
mockResolveWorkspacePath.mockReturnValue("/mock/workspace/path");

// Create a mock class for RuleService
class MockRuleService {
  listRules = createMockFunction();
  getRule = createMockFunction();
  createRule = createMockFunction();
  updateRule = createMockFunction();
  searchRules = createMockFunction();
  
  constructor(public workspacePath: string) {}
}

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

// Apply the mocks to the module imports
mock.module("../../../domain/workspace.js", () => ({
  resolveWorkspacePath: mockResolveWorkspacePath,
}));

// Mock the RuleService import
mock.module("../../../domain/rules.js", () => ({
  RuleService: MockRuleService,
}));

describe("Rules CLI Adapter", () => {  
  // Create console and process mocks for each test
  
  test("should display rules in human-readable format", async () => {
    // Mock console methods
    const consoleLogMock = createMockFunction();
    const consoleErrorMock = createMockFunction();
    const originalLog = console.log;
    const originalError = console.error;
    console.log = consoleLogMock as any;
    console.error = consoleErrorMock as any;
    
    // Mock process.exit
    const processExitMock = createMockFunction();
    const originalExit = process.exit;
    process.exit = processExitMock as any;
    
    try {
      // Setup the mock to return test data
      const mockRuleServiceInstance = new MockRuleService("/mock/workspace/path");
      mockRuleServiceInstance.listRules.mockReturnValue(mockRules);
      
      // Create the command
      const listCommand = createListCommand();
      
      // Execute the command action
      await listCommand.action({});
      
      // Verify appropriate mocks were called
      expect(consoleLogMock.calls.length).toBeGreaterThan(0);
      expect(consoleLogMock.calls.some(call => call[0] === "Found 2 rules:")).toBe(true);
      expect(consoleLogMock.calls.some(call => call[0].includes("test-rule-1"))).toBe(true);
      expect(consoleLogMock.calls.some(call => call[0].includes("test-rule-2"))).toBe(true);
    } finally {
      // Restore original console methods and process.exit
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
    }
  });
  
  test("should display message when no rules are found", async () => {
    // Mock console methods
    const consoleLogMock = createMockFunction();
    const consoleErrorMock = createMockFunction();
    const originalLog = console.log;
    const originalError = console.error;
    console.log = consoleLogMock as any;
    console.error = consoleErrorMock as any;
    
    // Mock process.exit
    const processExitMock = createMockFunction();
    const originalExit = process.exit;
    process.exit = processExitMock as any;
    
    try {
      // Setup mock to return empty array
      const mockRuleServiceInstance = new MockRuleService("/mock/workspace/path");
      mockRuleServiceInstance.listRules.mockReturnValue([]);
      
      // Create the command
      const listCommand = createListCommand();
      
      // Execute the command action
      await listCommand.action({});
      
      // Verify the appropriate mock was called with expected output
      expect(consoleLogMock.calls.some(call => call[0] === "No rules found")).toBe(true);
    } finally {
      // Restore original console methods and process.exit
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
    }
  });
}); 
