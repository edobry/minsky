import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { RuleService } from "./rules";
import type { RuleFormat } from "./rules";
import path from "path";
import matter from "gray-matter";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";

// Mock the fs modules to use our mock filesystem
const mockFs = createMockFilesystem();

mock.module("fs", () => ({
  existsSync: mockFs.existsSync,
  mkdirSync: mockFs.mkdirSync,
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  readdirSync: mockFs.readdirSync,
  promises: {
    mkdir: mockFs.mkdir,
    writeFile: mockFs.writeFile,
    readFile: mockFs.readFile,
    readdir: mockFs.readdir,
    rm: mockFs.rm,
    access: mockFs.access,
    mkdtemp: () => Promise.resolve("/mock/tmp/test-12345"),
  },
}));

mock.module("fs/promises", () => ({
  mkdir: mockFs.mkdir,
  writeFile: mockFs.writeFile,
  readFile: mockFs.readFile,
  readdir: mockFs.readdir,
  rm: mockFs.rm,
  mkdtemp: () => Promise.resolve("/mock/tmp/test-12345"),
}));

describe("RuleService", () => {
  let testDir: string;
  let cursorRulesDir: string;
  let genericRulesDir: string;
  let ruleService: RuleService;

  // Helper function to create a rule file in mock filesystem
  async function createTestRule(
    id: string,
    content: string,
    meta: Record<string, any> = {},
    format: RuleFormat = "cursor"
  ): Promise<string> {
    const dir = format === "cursor" ? cursorRulesDir : genericRulesDir;
    const filePath = path.join(dir, `${id}.mdc`);
    const fileContent = matter.stringify(content, meta);

    // Create directory structure in mock filesystem
    mockFs.ensureDirectorySync(dir);
    mockFs.writeFileSync(filePath, fileContent, "utf8");
    return filePath;
  }

  beforeEach(async () => {
    // Use mock paths instead of real temporary directories
    testDir = "/mock/test/rules";
    cursorRulesDir = path.join(testDir, ".cursor", "rules");
    genericRulesDir = path.join(testDir, ".ai", "rules");

    // Reset mock filesystem
    mockFs.reset();

    // Ensure base directories exist in mock filesystem
    mockFs.ensureDirectorySync(cursorRulesDir);
    mockFs.ensureDirectorySync(genericRulesDir);

    // Initialize service with test directory
    ruleService = new RuleService(testDir);
  });

  afterEach(() => {
    mock.restore();
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

    test("lists only cursor rules when format is cursor", async () => {
      await createTestRule("test-cursor", "Cursor rule content", { name: "Cursor Rule" }, "cursor");
      await createTestRule(
        "test-generic",
        "Generic rule content",
        { name: "Generic Rule" },
        "generic"
      );

      const rules = await ruleService.listRules({ format: "cursor" });

      expect(rules.length).toBe(1);
      expect(rules[0].id).toBe("test-cursor");
      expect(rules[0].format).toBe("cursor");
    });

    test("lists only generic rules when format is generic", async () => {
      await createTestRule("test-cursor", "Cursor rule content", { name: "Cursor Rule" }, "cursor");
      await createTestRule(
        "test-generic",
        "Generic rule content",
        { name: "Generic Rule" },
        "generic"
      );

      const rules = await ruleService.listRules({ format: "generic" });

      expect(rules.length).toBe(1);
      expect(rules[0].id).toBe("test-generic");
      expect(rules[0].format).toBe("generic");
    });
  });

  describe("findRuleById", () => {
    test("finds existing rule by id", async () => {
      await createTestRule("test-rule", "Test rule content", { name: "Test Rule" });

      const rule = await ruleService.findRuleById("test-rule");

      expect(rule).toBeTruthy();
      expect(rule?.id).toBe("test-rule");
      expect(rule?.name).toBe("Test Rule");
    });

    test("returns null for non-existing rule", async () => {
      const rule = await ruleService.findRuleById("non-existing");

      expect(rule).toBeNull();
    });
  });
});
