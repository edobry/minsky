import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { RuleService } from "./rules.js";
import type { Rule, RuleFormat } from "./rules.js";
import { promises as fs } from "fs";
import path from "path";
import matter from "gray-matter";
import { log } from "../utils/logger.js";

describe("RuleService", () => {
  const testDir = path.join(import.meta.dir, "../..", "test-rules-tmp");
  const cursorRulesDir = path.join(testDir, ".cursor", "rules");
  const genericRulesDir = path.join(testDir, ".ai", "rules");

  let ruleService: RuleService;

  // Helper function to create a rule file
  async function createTestRule(
    id: string,
    content: string,
    meta: any = {},
    format: RuleFormat = "cursor"
  ): Promise<string> {
    const dir = format === "cursor" ? cursorRulesDir : genericRulesDir;
    const filePath = path.join(dir, `${id}.mdc`);
    const fileContent = matter.stringify(content, meta);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, fileContent);
    return filePath;
  }

  beforeEach(async () => {
    // Create test directories
    await fs.mkdir(cursorRulesDir, { recursive: true });
    await fs.mkdir(genericRulesDir, { recursive: true });

    // Initialize service with test directory
    ruleService = new RuleService(testDir);
  });

  afterEach(async () => {
    // Clean up test directories
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      log.error("Failed to clean up test directory", {
        error: error instanceof Error ? error.message : String(error),
        testDir,
      });
    }
  });

  describe("listRules", () => {
    test("lists rules from both formats when no format specified", async () => {
      // Create test rules
      await createTestRule("test-cursor", "Cursor rule content", { name: "Cursor Rule" }, "cursor");
      await createTestRule(
        "test-generic",
        "Generic rule content",
        { name: "Generic Rule" },
        "generic"
      );

      const rules = await ruleService.listRules();

      expect(rules.length).toBe(2);
      const cursorRule = rules.find((r) => r.id === "test-cursor");
      const genericRule = rules.find((r) => r.id === "test-generic");
      expect(cursorRule).toBeTruthy();
      expect(genericRule).toBeTruthy();
    });

    test("filters rules by format", async () => {
      // Create test rules
      await createTestRule("test-cursor", "Cursor rule content", { name: "Cursor Rule" }, "cursor");
      await createTestRule(
        "test-generic",
        "Generic rule content",
        { name: "Generic Rule" },
        "generic"
      );

      const cursorRules = await ruleService.listRules({ format: "cursor" });
      expect(cursorRules.length).toBe(1);
      if (cursorRules[0]) {
        expect(cursorRules[0].id).toBe("test-cursor");
      }

      const genericRules = await ruleService.listRules({ format: "generic" });
      expect(genericRules.length).toBe(1);
      if (genericRules[0]) {
        expect(genericRules[0].id).toBe("test-generic");
      }
    });

    test("filters rules by tag", async () => {
      // Create test rules
      await createTestRule("test-with-tag", "Rule with tag", {
        name: "Tagged Rule",
        tags: ["test-tag"],
      });
      await createTestRule("test-no-tag", "Rule without tag", { name: "Untagged Rule" });

      const taggedRules = await ruleService.listRules({ tag: "test-tag" });
      expect(taggedRules.length).toBe(1);
      if (taggedRules[0]) {
        expect(taggedRules[0].id).toBe("test-with-tag");
      }
    });
  });

  describe("getRule", () => {
    test("gets a rule by ID", async () => {
      const meta = {
        name: "Test Rule",
        description: "Test description",
        globs: ["**/*.ts"],
        alwaysApply: true,
        tags: ["test"],
      };

      await createTestRule("test-rule", "Test rule content", meta);

      const rule = await ruleService.getRule("test-rule");

      expect(rule.id).toBe("test-rule");
      expect(rule.name).toBe(meta.name);
      expect(rule.description).toBe(meta.description);
      expect(rule.globs).toEqual(meta.globs);
      expect(rule.alwaysApply).toBe(meta.alwaysApply);
      expect(rule.tags).toEqual(meta.tags);
      expect(rule.content).toBe("Test rule content");
      expect(rule.format).toBe("cursor");
    });

    test("throws error for non-existent rule", async () => {
      await expect(ruleService.getRule("non-existent")).rejects.toThrow("Rule not found");
    });

    test("finds rule in specified format", async () => {
      await createTestRule("test-rule", "Cursor rule", { name: "Cursor Rule" }, "cursor");
      await createTestRule("test-rule", "Generic rule", { name: "Generic Rule" }, "generic");

      const cursorRule = await ruleService.getRule("test-rule", { format: "cursor" });
      expect(cursorRule.name).toBe("Cursor Rule");

      const genericRule = await ruleService.getRule("test-rule", { format: "generic" });
      expect(genericRule.name).toBe("Generic Rule");
    });
  });

  describe("createRule", () => {
    test("creates a new rule with metadata", async () => {
      const id = "new-rule";
      const content = "Rule content";
      const meta = {
        name: "New Rule",
        description: "A new test rule",
        globs: ["**/*.test.ts"],
        alwaysApply: false,
        tags: ["testing"],
      };

      const rule = await ruleService.createRule(id, content, meta);

      expect(rule.id).toBe(id);
      expect(rule.name).toBe(meta.name);
      expect(rule.description).toBe(meta.description);
      expect(rule.globs).toEqual(meta.globs);
      expect(rule.alwaysApply).toBe(meta.alwaysApply);
      expect(rule.tags).toEqual(meta.tags);
      expect(rule.content).toBe(content);

      // Verify file was created
      const filePath = path.join(cursorRulesDir, `${id}.mdc`);
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain(content);
      expect(fileContent).toContain(meta.name);
    });

    test("handles undefined metadata fields correctly", async () => {
      const id = "minimal-rule";
      const content = "Minimal rule content";
      const meta = {
        name: undefined,
        description: "A minimal rule",
        globs: undefined,
        alwaysApply: undefined,
      };

      const rule = await ruleService.createRule(id, content, meta);

      expect(rule.id).toBe(id);
      expect(rule.name).toBeUndefined();
      expect(rule.description).toBe(meta.description);
      expect(rule.globs).toBeUndefined();
      expect(rule.alwaysApply).toBeUndefined();

      // Verify file was created
      const filePath = path.join(cursorRulesDir, `${id}.mdc`);
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain(content);
      expect(fileContent).toContain(meta.description);

      // Ensure frontmatter doesn't have undefined values
      expect(fileContent.indexOf("undefined")).toBe(-1);
    });

    test("throws error if rule exists and overwrite is false", async () => {
      // Create a rule first
      await createTestRule("existing-rule", "Existing content");

      // Try to create it again
      await expect(ruleService.createRule("existing-rule", "New content", {})).rejects.toThrow(
        "Rule already exists"
      );
    });

    test("overwrites existing rule when overwrite is true", async () => {
      // Create a rule first
      await createTestRule("existing-rule", "Existing content");

      // Create it again with overwrite
      const rule = await ruleService.createRule(
        "existing-rule",
        "New content",
        { name: "Updated Rule" },
        { overwrite: true }
      );

      expect(rule.content).toBe("New content");
      expect(rule.name).toBe("Updated Rule");

      // Verify file was updated
      const filePath = path.join(cursorRulesDir, "existing-rule.mdc");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("New content");
      expect(fileContent).toContain("Updated Rule");
    });
  });

  describe("updateRule", () => {
    test("updates metadata only", async () => {
      // Create a rule first
      await createTestRule("update-test", "Original content", {
        name: "Original Name",
        description: "Original description",
      });

      // Update metadata only
      const rule = await ruleService.updateRule("update-test", {
        meta: {
          name: "Updated Name",
          description: "Updated description",
        },
      });

      expect(rule.name).toBe("Updated Name");
      expect(rule.description).toBe("Updated description");
      expect(rule.content).toBe("Original content"); // Content unchanged

      // Verify file was updated
      const filePath = path.join(cursorRulesDir, "update-test.mdc");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("Updated Name");
      expect(fileContent).toContain("Updated description");
      expect(fileContent).toContain("Original content");
    });

    test("updates content only", async () => {
      // Create a rule first
      await createTestRule("content-update-test", "Original content", { name: "Content Test" });

      // Update content only
      const rule = await ruleService.updateRule("content-update-test", {
        content: "Updated content",
      });

      expect(rule.name).toBe("Content Test"); // Metadata unchanged
      expect(rule.content).toBe("Updated content");

      // Verify file was updated
      const filePath = path.join(cursorRulesDir, "content-update-test.mdc");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("Content Test");
      expect(fileContent).toContain("Updated content");
    });

    test("updates both metadata and content", async () => {
      // Create a rule first
      await createTestRule("full-update-test", "Original content", {
        name: "Original Name",
        description: "Original description",
      });

      // Update both metadata and content
      const rule = await ruleService.updateRule("full-update-test", {
        content: "New content",
        meta: {
          name: "New Name",
          description: "New description",
        },
      });

      expect(rule.name).toBe("New Name");
      expect(rule.description).toBe("New description");
      expect(rule.content).toBe("New content");

      // Verify file was updated
      const filePath = path.join(cursorRulesDir, "full-update-test.mdc");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("New Name");
      expect(fileContent).toContain("New description");
      expect(fileContent).toContain("New content");
    });
  });

  describe("searchRules", () => {
    test("searches for rules by content", async () => {
      await createTestRule("rule1", "This rule contains searchable content");
      await createTestRule("rule2", "This rule has different text");

      const results = await ruleService.searchRules({ query: "searchable" });

      expect(results.length).toBe(1);
      if (results[0]) {
        expect(results[0].id).toBe("rule1");
      }
    });

    test("searches for rules by metadata", async () => {
      await createTestRule("rule1", "Rule content 1", {
        name: "First Rule",
        description: "This is searchable by description",
      });

      await createTestRule("rule2", "Rule content 2", {
        name: "Searchable by name",
        description: "Second rule description",
      });

      await createTestRule("rule3", "Rule content 3", {
        name: "Third Rule",
        description: "Third rule description",
        tags: ["searchable-tag"],
      });

      // Search by description
      const descResults = await ruleService.searchRules({ query: "searchable by description" });
      expect(descResults.length).toBe(1);
      if (descResults[0]) {
        expect(descResults[0].id).toBe("rule1");
      }

      // Search by name
      const nameResults = await ruleService.searchRules({ query: "searchable by name" });
      expect(nameResults.length).toBe(1);
      if (nameResults[0]) {
        expect(nameResults[0].id).toBe("rule2");
      }

      // Search by tag
      const tagResults = await ruleService.searchRules({ query: "searchable-tag" });
      expect(tagResults.length).toBe(1);
      if (tagResults[0]) {
        expect(tagResults[0].id).toBe("rule3");
      }
    });

    test("filters search results by format and tag", async () => {
      await createTestRule("cursor-rule", "Searchable content", { tags: ["test-tag"] }, "cursor");

      await createTestRule("generic-rule", "Searchable content", { tags: ["test-tag"] }, "generic");

      await createTestRule(
        "cursor-other-tag",
        "Searchable content",
        { tags: ["other-tag"] },
        "cursor"
      );

      // Filter by format only
      const formatResults = await ruleService.searchRules({
        query: "searchable",
        format: "cursor",
      });

      expect(formatResults.length).toBe(2);
      const hasFormat1 = formatResults.some((r) => r.id === "cursor-rule");
      const hasFormat2 = formatResults.some((r) => r.id === "cursor-other-tag");
      expect(hasFormat1).toBe(true);
      expect(hasFormat2).toBe(true);

      // Filter by tag only
      const tagResults = await ruleService.searchRules({
        query: "searchable",
        tag: "test-tag",
      });

      expect(tagResults.length).toBe(2);
      const hasTag1 = tagResults.some((r) => r.id === "cursor-rule");
      const hasTag2 = tagResults.some((r) => r.id === "generic-rule");
      expect(hasTag1).toBe(true);
      expect(hasTag2).toBe(true);

      // Filter by both format and tag
      const combinedResults = await ruleService.searchRules({
        query: "searchable",
        format: "cursor",
        tag: "test-tag",
      });

      expect(combinedResults.length).toBe(1);
      if (combinedResults[0]) {
        expect(combinedResults[0].id).toBe("cursor-rule");
      }
    });
  });
});
