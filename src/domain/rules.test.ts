import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { RuleService, Rule, RuleMeta } from "./rules";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

// Mock fs promises
const mockFs = mock.module("fs", () => {
  return {
    promises: {
      readdir: mock.fn(),
      readFile: mock.fn(),
      writeFile: mock.fn(),
      access: mock.fn(),
      mkdir: mock.fn(),
    },
    existsSync: mock.fn(),
  };
});

// Sample rules
const cursorRule: Rule = {
  id: "test-rule",
  name: "Test Rule",
  description: "A test rule",
  globs: ["**/*.ts", "**/*.js"],
  alwaysApply: false,
  tags: ["test", "example"],
  content: "# Test Rule\n\nThis is a test rule content.\n",
  format: "cursor",
  path: "/test-repo/.cursor/rules/test-rule.mdc",
};

const genericRule: Rule = {
  id: "generic-rule",
  name: "Generic Rule",
  description: "A generic test rule",
  globs: ["**/*.md"],
  alwaysApply: true,
  tags: ["generic", "example"],
  content: "# Generic Rule\n\nThis is a generic rule content.\n",
  format: "generic",
  path: "/test-repo/.ai/rules/generic-rule.mdc",
};

// Create sample rule files
const createSampleRuleFile = (rule: Rule): string => {
  const meta: RuleMeta = {
    name: rule.name,
    description: rule.description,
    globs: rule.globs,
    alwaysApply: rule.alwaysApply,
    tags: rule.tags,
  };
  return matter.stringify(rule.content, meta);
};

describe("RuleService", () => {
  const workspacePath = "/test-repo";
  let ruleService: RuleService;
  
  beforeEach(() => {
    ruleService = new RuleService(workspacePath);
    
    // Reset all mocks
    mockFs.promises.readdir.mockReset();
    mockFs.promises.readFile.mockReset();
    mockFs.promises.writeFile.mockReset();
    mockFs.promises.access.mockReset();
    mockFs.promises.mkdir.mockReset();
    mockFs.existsSync.mockReset();
  });
  
  describe("listRules", () => {
    test("should list all rules from both formats when no format is specified", async () => {
      // Mock directory listing
      mockFs.promises.readdir
        .mockImplementationOnce(() => Promise.resolve(["test-rule.mdc", "other-rule.mdc"]))
        .mockImplementationOnce(() => Promise.resolve(["generic-rule.mdc"]));
      
      // Mock file reading
      mockFs.promises.access.mockImplementation(() => Promise.resolve());
      mockFs.promises.readFile
        .mockImplementation((path: string) => {
          if (path.includes("test-rule.mdc")) {
            return Promise.resolve(createSampleRuleFile(cursorRule));
          } else if (path.includes("generic-rule.mdc")) {
            return Promise.resolve(createSampleRuleFile(genericRule));
          } else {
            return Promise.resolve(createSampleRuleFile({
              ...cursorRule,
              id: "other-rule",
              name: "Other Rule",
              path: "/test-repo/.cursor/rules/other-rule.mdc",
            }));
          }
        });
      
      const rules = await ruleService.listRules();
      expect(rules).toHaveLength(3);
      expect(rules.some(r => r.id === "test-rule")).toBe(true);
      expect(rules.some(r => r.id === "other-rule")).toBe(true);
      expect(rules.some(r => r.id === "generic-rule")).toBe(true);
    });
    
    test("should filter rules by format", async () => {
      // Mock directory listing
      mockFs.promises.readdir
        .mockImplementationOnce(() => Promise.resolve(["test-rule.mdc", "other-rule.mdc"]));
      
      // Mock file reading
      mockFs.promises.access.mockImplementation(() => Promise.resolve());
      mockFs.promises.readFile.mockImplementation(() => Promise.resolve(createSampleRuleFile(cursorRule)));
      
      const rules = await ruleService.listRules({ format: "cursor" });
      expect(rules).toHaveLength(2);
      expect(rules.every(r => r.format === "cursor")).toBe(true);
    });
    
    test("should filter rules by tag", async () => {
      // Mock directory listing
      mockFs.promises.readdir
        .mockImplementationOnce(() => Promise.resolve(["test-rule.mdc"]))
        .mockImplementationOnce(() => Promise.resolve(["generic-rule.mdc"]));
      
      // Mock file reading
      mockFs.promises.access.mockImplementation(() => Promise.resolve());
      mockFs.promises.readFile
        .mockImplementationOnce(() => Promise.resolve(createSampleRuleFile(cursorRule)))
        .mockImplementationOnce(() => Promise.resolve(createSampleRuleFile(genericRule)));
      
      const rules = await ruleService.listRules({ tag: "test" });
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("test-rule");
    });
  });
  
  describe("getRule", () => {
    test("should get a rule by id", async () => {
      // Mock file reading
      mockFs.promises.access.mockImplementation((path: string) => {
        if (path.includes("test-rule.mdc")) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("File not found"));
      });
      
      mockFs.promises.readFile.mockImplementation(() => Promise.resolve(createSampleRuleFile(cursorRule)));
      
      const rule = await ruleService.getRule("test-rule");
      expect(rule).toBeDefined();
      expect(rule.id).toBe("test-rule");
      expect(rule.name).toBe("Test Rule");
      expect(rule.format).toBe("cursor");
    });
    
    test("should throw an error if rule is not found", async () => {
      // Mock file access rejection
      mockFs.promises.access.mockImplementation(() => Promise.reject(new Error("File not found")));
      
      await expect(ruleService.getRule("non-existent")).rejects.toThrow("Rule not found");
    });
  });
  
  describe("createRule", () => {
    test("should create a new rule", async () => {
      // Mock file checks
      mockFs.existsSync.mockImplementation(() => false);
      mockFs.promises.mkdir.mockImplementation(() => Promise.resolve());
      mockFs.promises.writeFile.mockImplementation(() => Promise.resolve());
      
      const meta: RuleMeta = {
        name: "New Rule",
        description: "A new test rule",
        globs: ["**/*.ts"],
        alwaysApply: false,
        tags: ["new", "test"],
      };
      
      const content = "# New Rule\n\nThis is a new rule content.\n";
      
      const rule = await ruleService.createRule("new-rule", content, meta);
      
      expect(rule).toBeDefined();
      expect(rule.id).toBe("new-rule");
      expect(rule.name).toBe("New Rule");
      expect(mockFs.promises.writeFile).toHaveBeenCalled();
    });
    
    test("should throw an error if rule already exists", async () => {
      // Mock file exists
      mockFs.existsSync.mockImplementation(() => true);
      
      const meta: RuleMeta = {
        name: "Existing Rule",
      };
      
      const content = "# Existing Rule\n\nThis rule already exists.\n";
      
      await expect(ruleService.createRule("existing-rule", content, meta))
        .rejects.toThrow("Rule already exists");
    });
  });
  
  describe("updateRule", () => {
    test("should update a rule's metadata", async () => {
      // Mock file reading and writing
      mockFs.promises.access.mockImplementation(() => Promise.resolve());
      mockFs.promises.readFile.mockImplementation(() => Promise.resolve(createSampleRuleFile(cursorRule)));
      mockFs.promises.writeFile.mockImplementation(() => Promise.resolve());
      
      const updatedRule = await ruleService.updateRule("test-rule", {
        meta: {
          description: "Updated description",
        },
      });
      
      expect(updatedRule).toBeDefined();
      expect(updatedRule.description).toBe("Updated description");
      expect(mockFs.promises.writeFile).toHaveBeenCalled();
    });
    
    test("should update a rule's content", async () => {
      // Mock file reading and writing
      mockFs.promises.access.mockImplementation(() => Promise.resolve());
      mockFs.promises.readFile.mockImplementation(() => Promise.resolve(createSampleRuleFile(cursorRule)));
      mockFs.promises.writeFile.mockImplementation(() => Promise.resolve());
      
      const newContent = "# Updated Content\n\nThis content has been updated.\n";
      
      const updatedRule = await ruleService.updateRule("test-rule", {
        content: newContent,
      });
      
      expect(updatedRule).toBeDefined();
      expect(updatedRule.content).toBe(newContent);
      expect(mockFs.promises.writeFile).toHaveBeenCalled();
    });
  });
  
  describe("searchRules", () => {
    test("should search rules by content", async () => {
      // Mock directory listing
      mockFs.promises.readdir
        .mockImplementationOnce(() => Promise.resolve(["test-rule.mdc"]))
        .mockImplementationOnce(() => Promise.resolve(["generic-rule.mdc"]));
      
      // Mock file reading
      mockFs.promises.access.mockImplementation(() => Promise.resolve());
      mockFs.promises.readFile
        .mockImplementationOnce(() => Promise.resolve(createSampleRuleFile(cursorRule)))
        .mockImplementationOnce(() => Promise.resolve(createSampleRuleFile(genericRule)));
      
      const rules = await ruleService.searchRules({ query: "test rule" });
      
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("test-rule");
    });
    
    test("should search rules by description", async () => {
      // Mock directory listing
      mockFs.promises.readdir
        .mockImplementationOnce(() => Promise.resolve(["test-rule.mdc"]))
        .mockImplementationOnce(() => Promise.resolve(["generic-rule.mdc"]));
      
      // Mock file reading
      mockFs.promises.access.mockImplementation(() => Promise.resolve());
      mockFs.promises.readFile
        .mockImplementationOnce(() => Promise.resolve(createSampleRuleFile(cursorRule)))
        .mockImplementationOnce(() => Promise.resolve(createSampleRuleFile(genericRule)));
      
      const rules = await ruleService.searchRules({ query: "generic" });
      
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("generic-rule");
    });
  });
}); 
