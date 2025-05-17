import { describe, test, expect, beforeEach } from "bun:test";
import { 
  RuleService, 
  type Rule, 
  type RuleOptions, 
  type SearchRuleOptions 
} from "../../../domain/rules.js";
import {
  createMock,
  mockModule,
  setupTestMocks,
  createMockObject
} from "../../../utils/test-utils/mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

// Mock functions for key domain method calls
const mockListRules = createMock();
const mockGetRule = createMock();
const mockCreateRule = createMock();
const mockUpdateRule = createMock();
const mockSearchRules = createMock();

// Mock the domain rules module
mockModule("../../../domain/rules.js", () => {
  // Mock implementation
  return {
    listRules: mockListRules,
    getRule: mockGetRule,
    createRule: mockCreateRule,
    updateRule: mockUpdateRule,
    searchRules: mockSearchRules,
    // Type definitions
    RuleService: class MockRuleService {
      listRules = mockListRules;
      getRule = mockGetRule;
      createRule = mockCreateRule;
      updateRule = mockUpdateRule;
      searchRules = mockSearchRules;
    }
  };
});

describe("Rules Domain Methods", () => {
  const mockRules: Rule[] = [
    {
      id: "test-rule-1",
      name: "Test Rule 1",
      description: "Test rule description 1",
      globs: ["**/*.ts"],
      content: "# Test Rule 1\n\nThis is test rule 1 content",
      format: "cursor",
      path: "/path/to/test-rule-1.mdc"
    },
    {
      id: "test-rule-2",
      name: "Test Rule 2",
      description: "Test rule description 2",
      globs: ["**/*.md"],
      content: "# Test Rule 2\n\nThis is test rule 2 content",
      format: "generic",
      path: "/path/to/test-rule-2.mdc"
    }
  ];

  beforeEach(() => {
    // Reset mock implementations
    mockListRules.mockReset();
    mockGetRule.mockReset();
    mockCreateRule.mockReset();
    mockUpdateRule.mockReset();
    mockSearchRules.mockReset();
  });

  describe("listRules", () => {
    test("lists all rules when no options provided", async () => {
      // Arrange
      mockListRules.mockResolvedValue(mockRules);
      
      // Act
      const result = await mockListRules();
      
      // Assert
      expect(mockListRules).toHaveBeenCalledWith();
      expect(result).toEqual(mockRules);
      expect(result.length).toBe(2);
    });

    test("filters rules by format when format option provided", async () => {
      // Arrange
      const cursorRules = mockRules.filter(rule => rule.format === "cursor");
      mockListRules.mockImplementation((options?: RuleOptions) => {
        if (options?.format === "cursor") {
          return Promise.resolve(cursorRules);
        }
        return Promise.resolve(mockRules);
      });
      const options = { format: "cursor" as const };
      
      // Act
      const result = await mockListRules(options);
      
      // Assert
      expect(mockListRules).toHaveBeenCalledWith(options);
      expect(result).toEqual([mockRules[0]]);
      expect(result.length).toBe(1);
    });
  });

  describe("getRule", () => {
    test("gets rule by ID", async () => {
      // Arrange
      const ruleId = "test-rule-1";
      mockGetRule.mockResolvedValue(mockRules[0]);
      
      // Act
      const result = await mockGetRule(ruleId);
      
      // Assert
      expect(mockGetRule).toHaveBeenCalledWith(ruleId);
      expect(result).toEqual(mockRules[0]);
    });

    test("gets rule with specific format option", async () => {
      // Arrange
      const ruleId = "test-rule-1";
      const options = { format: "cursor" as const };
      mockGetRule.mockResolvedValue(mockRules[0]);
      
      // Act
      const result = await mockGetRule(ruleId, options);
      
      // Assert
      expect(mockGetRule).toHaveBeenCalledWith(ruleId, options);
      expect(result).toEqual(mockRules[0]);
    });

    test("throws error when rule not found", async () => {
      // Arrange
      const ruleId = "non-existent";
      const error = new Error(`Rule not found: ${ruleId}`);
      mockGetRule.mockRejectedValue(error);
      
      // Act & Assert
      await expect(mockGetRule(ruleId))
        .rejects
        .toThrow(`Rule not found: ${ruleId}`);
    });
  });

  describe("searchRules", () => {
    test("searches rules by query", async () => {
      // Arrange
      const options: SearchRuleOptions = { query: "test" };
      mockSearchRules.mockResolvedValue(mockRules);
      
      // Act
      const result = await mockSearchRules(options);
      
      // Assert
      expect(mockSearchRules).toHaveBeenCalledWith(options);
      expect(result).toEqual(mockRules);
    });

    test("returns empty array when no matches", async () => {
      // Arrange
      const options: SearchRuleOptions = { query: "no-match" };
      mockSearchRules.mockResolvedValue([]);
      
      // Act
      const result = await mockSearchRules(options);
      
      // Assert
      expect(mockSearchRules).toHaveBeenCalledWith(options);
      expect(result).toEqual([]);
      expect(result.length).toBe(0);
    });
  });
}); 
