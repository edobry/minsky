import { describe, expect, test, beforeEach } from "bun:test";
import { RuleService } from "./rules";
import * as path from "path";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";
import { RULES_TEST_PATTERNS } from "../utils/test-utils/test-constants";

// No global module mocks. Each test creates its own mock filesystem and injects it

describe("RuleService Format Compatibility", () => {
  let testDir: string;
  let cursorRulesDir: string;
  let genericRulesDir: string;
  let ruleService: RuleService;
  let mockFs: ReturnType<typeof createMockFilesystem>;

  // Setup before each test
  beforeEach(() => {
    // Create a unique mock filesystem per test
    mockFs = createMockFilesystem();
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

    // Initialize rule service with injected fs
    ruleService = new RuleService(testDir, {
      fsPromises: mockFs.fsPromises,
      existsSyncFn: (p: string) => mockFs.existsSync(p),
    });
  });

  // Cleanup handled by fresh mockFs per test

  test("should get a rule in its original format when requested", async () => {
    const cursorRule = await ruleService.getRule(RULES_TEST_PATTERNS.CURSOR_ONLY_RULE, {
      format: "cursor",
    });
    expect(cursorRule.format).toBe("cursor");
    expect(cursorRule.description).toBe("Test cursor rule");
    expect(cursorRule.formatNote).toBeUndefined();

    const genericRule = await ruleService.getRule(RULES_TEST_PATTERNS.GENERIC_ONLY_RULE, {
      format: "generic",
    });
    expect(genericRule.format).toBe("generic");
    expect(genericRule.description).toBe("Test generic rule");
    expect(genericRule.formatNote).toBeUndefined();
  });

  test("should get a rule in any format if no format specified", async () => {
    const cursorRule = await ruleService.getRule(RULES_TEST_PATTERNS.CURSOR_ONLY_RULE);
    expect(cursorRule.format).toBe("cursor");
    expect(cursorRule.description).toBe("Test cursor rule");

    const genericRule = await ruleService.getRule(RULES_TEST_PATTERNS.GENERIC_ONLY_RULE);
    expect(genericRule.format).toBe("generic");
    expect(genericRule.description).toBe("Test generic rule");
  });

  test("should return rule with format note when requested in different format", async () => {
    // When requesting a cursor-only rule in generic format
    const cursorAsGeneric = await ruleService.getRule(RULES_TEST_PATTERNS.CURSOR_ONLY_RULE, {
      format: "generic",
    });
    expect(cursorAsGeneric.format).toBe("cursor"); // Format is still the original
    expect(cursorAsGeneric.formatNote).toBeDefined();
    expect(cursorAsGeneric.formatNote).toContain(
      "Rule found in 'cursor' format but 'generic' was requested"
    );

    // When requesting a generic-only rule in cursor format
    const genericAsCursor = await ruleService.getRule(RULES_TEST_PATTERNS.GENERIC_ONLY_RULE, {
      format: "cursor",
    });
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
