import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { RuleService } from "./rules";
import * as path from "path";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";

// Mock the fs modules to use our mock filesystem
const mockFs = createMockFilesystem();

// Use mock filesystem directly - no real fs imports needed

mock.module("fs", () => ({
  mkdirSync: mockFs.mkdirSync,
  writeFileSync: mockFs.writeFileSync,
  existsSync: mockFs.existsSync,
  readFileSync: mockFs.readFileSync,
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

describe("RuleService Format Compatibility", () => {
  let testDir: string;
  let cursorRulesDir: string;
  let genericRulesDir: string;
  let ruleService: RuleService;

  // Setup before each test
  beforeEach(() => {
    // Create a unique temporary directory for each test run
    // Reset mock filesystem and use mock paths
    mockFs.reset();
    testDir = "/mock/test/rules-format";
    cursorRulesDir = path.join(testDir, ".cursor", "rules");
    genericRulesDir = path.join(testDir, ".ai", "rules");

    // Create directories in mock filesystem
    mockFs.ensureDirectorySync(cursorRulesDir);
    mockFs.ensureDirectorySync(genericRulesDir);

    // Create a cursor rule
    const cursorRuleContent = `---
description: Test cursor rule
globs: ["**/*.ts"]
alwaysApply: false
tags: ["test", "cursor"]
---
# Test Cursor Rule
This is a test rule in cursor format.
`;
    mockFs.writeFileSync(
      path.join(cursorRulesDir, "cursor-only-rule.mdc"),
      cursorRuleContent,
      "utf8"
    );

    // Create a generic rule
    const genericRuleContent = `---
description: Test generic rule
globs: ["**/*.js"]
alwaysApply: true
tags: ["test", "generic"]
---
# Test Generic Rule
This is a test rule in generic format.
`;
    mockFs.writeFileSync(
      path.join(genericRulesDir, "generic-only-rule.mdc"),
      genericRuleContent,
      "utf8"
    );

    // Create a rule that exists in both formats
    mockFs.writeFileSync(
      path.join(cursorRulesDir, "both-formats-rule.mdc"),
      `---
description: Cursor version of dual-format rule
globs: ["**/*.tsx"]
tags: ["test", "cursor", "dual"]
---
# Cursor Version
This rule exists in both cursor and generic formats.
`,
      "utf8"
    );

    mockFs.writeFileSync(
      path.join(genericRulesDir, "both-formats-rule.mdc"),
      `---
description: Generic version of dual-format rule
globs: ["**/*.jsx"]
tags: ["test", "generic", "dual"]
---
# Generic Version
This rule exists in both cursor and generic formats.
`,
      "utf8"
    );

    // Initialize rule service
    ruleService = new RuleService(testDir);
  });

  afterEach(() => {
    mock.restore();
  });

  // Cleanup handled automatically by createCleanTempDir

  test("should get a rule in its original format when requested", async () => {
    const cursorRule = await ruleService.getRule("cursor-only-rule", { format: "cursor" });
    expect(cursorRule.format).toBe("cursor");
    expect(cursorRule.description).toBe("Test cursor rule");
    expect(cursorRule.formatNote).toBeUndefined();

    const genericRule = await ruleService.getRule("generic-only-rule", { format: "generic" });
    expect(genericRule.format).toBe("generic");
    expect(genericRule.description).toBe("Test generic rule");
    expect(genericRule.formatNote).toBeUndefined();
  });

  test("should get a rule in any format if no format specified", async () => {
    const cursorRule = await ruleService.getRule("cursor-only-rule");
    expect(cursorRule.format).toBe("cursor");
    expect(cursorRule.description).toBe("Test cursor rule");

    const genericRule = await ruleService.getRule("generic-only-rule");
    expect(genericRule.format).toBe("generic");
    expect(genericRule.description).toBe("Test generic rule");
  });

  test("should return rule with format note when requested in different format", async () => {
    // When requesting a cursor-only rule in generic format
    const cursorAsGeneric = await ruleService.getRule("cursor-only-rule", { format: "generic" });
    expect(cursorAsGeneric.format).toBe("cursor"); // Format is still the original
    expect(cursorAsGeneric.formatNote).toBeDefined();
    expect(cursorAsGeneric.formatNote).toContain(
      "Rule found in 'cursor' format but 'generic' was requested"
    );

    // When requesting a generic-only rule in cursor format
    const genericAsCursor = await ruleService.getRule("generic-only-rule", { format: "cursor" });
    expect(genericAsCursor.format).toBe("generic"); // Format is still the original
    expect(genericAsCursor.formatNote).toBeDefined();
    expect(genericAsCursor.formatNote).toContain(
      "Rule found in 'generic' format but 'cursor' was requested"
    );
  });

  test("should prioritize the requested format for dual-format rules", async () => {
    // When requesting cursor format for a rule that exists in both formats
    const cursorVersion = await ruleService.getRule("both-formats-rule", { format: "cursor" });
    expect(cursorVersion.format).toBe("cursor");
    expect(cursorVersion.description).toBe("Cursor version of dual-format rule");
    expect(cursorVersion.formatNote).toBeUndefined();

    // When requesting generic format for a rule that exists in both formats
    const genericVersion = await ruleService.getRule("both-formats-rule", { format: "generic" });
    expect(genericVersion.format).toBe("generic");
    expect(genericVersion.description).toBe("Generic version of dual-format rule");
    expect(genericVersion.formatNote).toBeUndefined();
  });

  test("should throw specific error messages for non-existent rules", async () => {
    // No format specified
    await expect(ruleService.getRule("non-existent-rule")).rejects.toThrow(
      "Rule not found: non-existent-rule"
    );

    // Format specified
    await expect(ruleService.getRule("non-existent-rule", { format: "cursor" })).rejects.toThrow(
      "Rule 'non-existent-rule' not found in 'cursor' format or any other available format"
    );
  });
});
