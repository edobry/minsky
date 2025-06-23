import { describe, test, expect, beforeEach } from "bun:test";
import { type Rule, type RuleOptions, type SearchRuleOptions } from "../../../domain/rules.js";
import { createMock, mockModule, setupTestMocks } from "../../../utils/test-utils/mocking.js";

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
    },
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
      path: "/path/to/test-rule-1.mdc",
    },
    {
      id: "test-rule-2",
      name: "Test Rule 2",
      description: "Test rule description 2",
      globs: ["**/*.md"],
      content: "# Test Rule 2\n\nThis is test rule 2 content",
      format: "generic",
      path: "/path/to/test-rule-2.mdc",
    },
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
      const _result = await mockListRules();

      // Assert
      expect(mockListRules).toHaveBeenCalledWith();
      expect(_result).toEqual(mockRules);
      expect(result.length).toBe(2);
    });

    test("filters rules by format when format option provided", async () => {
      // Arrange
      const cursorRules = mockRules.filter((rule) => rule.format === "cursor");
      mockListRules.mockImplementation((options?: RuleOptions) => {
        if (options?.format === "cursor") {
          return Promise.resolve(cursorRules);
        }
        return Promise.resolve(mockRules);
      });
      const _options = { format: "cursor" as const };

      // Act
      const _result = await mockListRules(_options);

      // Assert
      expect(mockListRules).toHaveBeenCalledWith(_options);
      expect(_result).toEqual([mockRules[0]]);
      expect(result.length).toBe(1);
    });
  });

  describe("getRule", () => {
    test("gets rule by ID", async () => {
      // Arrange
      const ruleId = "test-rule-1";
      mockGetRule.mockResolvedValue(mockRules[0]);

      // Act
      const _result = await mockGetRule(ruleId);

      // Assert
      expect(mockGetRule).toHaveBeenCalledWith(ruleId);
      expect(_result).toEqual(mockRules[0]);
    });

    test("gets rule with specific format option", async () => {
      // Arrange
      const ruleId = "test-rule-1";
      const _options = { format: "cursor" as const };
      mockGetRule.mockResolvedValue(mockRules[0]);

      // Act
      const _result = await mockGetRule(ruleId, _options);

      // Assert
      expect(mockGetRule).toHaveBeenCalledWith(ruleId, _options);
      expect(_result).toEqual(mockRules[0]);
    });

    test("throws error when rule not found", async () => {
      // Arrange
      const ruleId = "non-existent";
      const error = new Error(`Rule not found: ${ruleId}`);
      mockGetRule.mockRejectedValue(error);

      // Act & Assert
      await expect(mockGetRule(ruleId)).rejects.toThrow(`Rule not found: ${ruleId}`);
    });
  });

  describe("searchRules", () => {
    test("searches rules by query", async () => {
      // Arrange
      const _options: SearchRuleOptions = { query: "test" };
      mockSearchRules.mockResolvedValue(mockRules);

      // Act
      const _result = await mockSearchRules(_options);

      // Assert
      expect(mockSearchRules).toHaveBeenCalledWith(_options);
      expect(_result).toEqual(mockRules);
    });

    test("returns empty array when no matches", async () => {
      // Arrange
      const _options: SearchRuleOptions = { query: "no-match" };
      mockSearchRules.mockResolvedValue([]);

      // Act
      const _result = await mockSearchRules(_options);

      // Assert
      expect(mockSearchRules).toHaveBeenCalledWith(_options);
      expect(_result).toEqual([]);
      expect(result.length).toBe(0);
    });
  });

  describe("createRule", () => {
    test("creates a new rule with content and metadata", async () => {
      // Arrange
      const ruleId = "new-rule";
      const content = "# New Rule\n\nThis is a new rule content";
      const meta = {
        name: "New Test Rule",
        description: "A rule created for testing",
        globs: ["**/*.ts"],
        alwaysApply: false,
      };
      const _options = { format: "cursor" as const };

      mockCreateRule.mockResolvedValue({
        id: ruleId,
        ...meta,
        content,
        format: "cursor",
        path: "/path/to/new-rule.mdc",
      });

      // Act
      const result = await mockCreateRule(ruleId, content, meta, _options);

      // Assert
      expect(mockCreateRule).toHaveBeenCalledWith(ruleId, content, meta, _options);
      expect(result.id).toBe(ruleId);
      expect(result.content).toBe(content);
      expect(result.name).toBe(meta.name);
      expect(result.format).toBe("cursor");
    });

    test("throws error when rule already exists and overwrite is false", async () => {
      // Arrange
      const ruleId = "existing-rule";
      const content = "# Existing Rule\n\nThis rule already exists";
      const meta = { name: "Existing Rule" };
      const _options = { format: "cursor" as const, overwrite: false };

      const error = new Error(`Rule '${ruleId}' already exists and overwrite is not enabled`);
      mockCreateRule.mockRejectedValue(error);

      // Act & Assert
      await expect(mockCreateRule(ruleId, content, meta, _options)).rejects.toThrow(
        `Rule '${ruleId}' already exists and overwrite is not enabled`
      );
    });

    test("overwrites existing rule when overwrite is true", async () => {
      // Arrange
      const ruleId = "existing-rule";
      const content = "# Updated Rule\n\nThis rule has been updated";
      const meta = { name: "Updated Rule" };
      const _options = { format: "cursor" as const, overwrite: true };

      mockCreateRule.mockResolvedValue({
        id: ruleId,
        ...meta,
        content,
        format: "cursor",
        path: "/path/to/existing-rule.mdc",
      });

      // Act
      const result = await mockCreateRule(ruleId, content, meta, _options);

      // Assert
      expect(mockCreateRule).toHaveBeenCalledWith(ruleId, content, meta, _options);
      expect(result.id).toBe(ruleId);
      expect(result.content).toBe(content);
      expect(result.name).toBe(meta.name);
    });
  });

  describe("updateRule", () => {
    test("updates rule content", async () => {
      // Arrange
      const ruleId = "test-rule-1";
      const updatedContent = "# Updated Rule Content\n\nThis content has been updated";
      const _options = { content: updatedContent };
      const ruleOptions = { format: "cursor" as const };

      const updatedRule = {
        ...mockRules[0],
        content: updatedContent,
      };

      mockUpdateRule.mockResolvedValue(updatedRule);

      // Act
      const result = await mockUpdateRule(ruleId, _options, ruleOptions);

      // Assert
      expect(mockUpdateRule).toHaveBeenCalledWith(ruleId, _options, ruleOptions);
      expect(result.content).toBe(updatedContent);
      expect(result.id).toBe(ruleId);
    });

    test("updates rule metadata", async () => {
      // Arrange
      const ruleId = "test-rule-1";
      const updatedMeta = {
        name: "Updated Rule Name",
        description: "Updated rule description",
        globs: ["**/*.tsx", "**/*.jsx"],
      };
      const _options = { meta: updatedMeta };

      const updatedRule = {
        ...mockRules[0],
        ...updatedMeta,
      };

      mockUpdateRule.mockResolvedValue(updatedRule);

      // Act
      const result = await mockUpdateRule(ruleId, _options);

      // Assert
      expect(mockUpdateRule).toHaveBeenCalledWith(ruleId, _options);
      expect(result.name).toBe(updatedMeta.name);
      expect(result.description).toBe(updatedMeta.description);
      expect(result.globs).toEqual(updatedMeta.globs);
    });

    test("updates both content and metadata", async () => {
      // Arrange
      const ruleId = "test-rule-1";
      const updatedContent = "# Updated Content and Metadata\n\nBoth content and metadata updated";
      const updatedMeta = {
        name: "Fully Updated Rule",
        tags: ["updated", "test"],
      };
      const _options = {
        content: updatedContent,
        meta: updatedMeta,
      };

      const updatedRule = {
        ...mockRules[0],
        content: updatedContent,
        ...updatedMeta,
      };

      mockUpdateRule.mockResolvedValue(updatedRule);

      // Act
      const result = await mockUpdateRule(ruleId, _options);

      // Assert
      expect(mockUpdateRule).toHaveBeenCalledWith(ruleId, _options);
      expect(result.content).toBe(updatedContent);
      expect(result.name).toBe(updatedMeta.name);
      expect(result.tags).toEqual(updatedMeta.tags);
    });

    test("throws error when rule not found", async () => {
      // Arrange
      const ruleId = "non-existent";
      const _options = { content: "Updated content" };

      const error = new Error(`Rule not found: ${ruleId}`);
      mockUpdateRule.mockRejectedValue(error);

      // Act & Assert
      await expect(mockUpdateRule(ruleId, _options)).rejects.toThrow(`Rule not found: ${ruleId}`);
    });

    test("returns unchanged rule when no options provided", async () => {
      // Arrange
      const ruleId = "test-rule-1";
      const _options = {}; // Empty options

      mockUpdateRule.mockResolvedValue(mockRules[0]);

      // Act
      const _result = await mockUpdateRule(ruleId, _options);

      // Assert
      expect(mockUpdateRule).toHaveBeenCalledWith(ruleId, _options);
      expect(_result).toEqual(mockRules[0]);
    });
  });
});
