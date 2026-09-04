import { beforeEach, afterEach, describe, test, expect } from "bun:test";
import { mock } from "bun:test";
import { createSharedCommandRegistry } from "../command-registry";
import { registerRulesCommands, type RulesCommandsDeps } from "./rules";
import { first, elementAt } from "@minsky/shared/array-safety";
import { RuleService } from "@minsky/domain/rules";

/** Shape returned by rules.list command */
interface RulesListResult {
  success: boolean;
  rules: Array<{
    id: string;
    name: string;
    description?: string;
    format: string;
    path: string;
    tags?: string[];
    globs?: string[];
  }>;
}

describe("Rules Commands", () => {
  // Inject mock deps instead of mock.module
  const mockDeps: RulesCommandsDeps = {
    resolveWorkspacePath: mock(() =>
      Promise.resolve("/mock/workspace")
    ) as RulesCommandsDeps["resolveWorkspacePath"],
  };

  let testRegistry: ReturnType<typeof createSharedCommandRegistry>;
  // Save the original RuleService.prototype.listRules so tests that
  // prototype-patch it for mocking can restore it in afterEach — otherwise
  // the mutation leaks across test files (mt#1115).
  let originalListRules: unknown;

  beforeEach(() => {
    // Create a fresh registry for each test to avoid interference
    testRegistry = createSharedCommandRegistry();

    // Register commands in the test registry with injected deps
    registerRulesCommands(testRegistry, mockDeps);

    originalListRules = RuleService.prototype.listRules;
  });

  afterEach(() => {
    // Restore RuleService.prototype.listRules to prevent prototype pollution
    // leaking into other test files.
    RuleService.prototype.listRules = originalListRules as typeof RuleService.prototype.listRules;
  });

  describe("rules.list", () => {
    test("should be registered in command registry", () => {
      const command = testRegistry.getCommand("rules.list");
      expect(command).toBeDefined();
      expect(command?.name).toBe("list");
    });

    test("should exclude content field from returned rules", async () => {
      // Mock RuleService to return rules with content
      const mockRules = [
        {
          id: "test-rule-1",
          name: "Test Rule 1",
          description: "A test rule",
          content: "This is the rule content that should be excluded",
          format: "cursor" as const,
          path: "/mock/path/test-rule-1.mdc",
          tags: ["test"],
          globs: ["*.ts"],
        },
        {
          id: "test-rule-2",
          name: "Test Rule 2",
          description: "Another test rule",
          content: "Another rule content that should be excluded",
          format: "generic" as const,
          path: "/mock/path/test-rule-2.mdc",
        },
      ];

      // Mock the RuleService
      const mockListRules = mock(() =>
        Promise.resolve(mockRules)
      ) as unknown as typeof RuleService.prototype.listRules;
      RuleService.prototype.listRules = mockListRules;

      const command = testRegistry.getCommand("rules.list");
      expect(command).toBeDefined();

      if (command) {
        const result = (await command.execute(
          {
            format: undefined,
            tag: undefined,
            json: true,
            debug: false,
          },
          {}
        )) as RulesListResult;

        expect(result.success).toBe(true);
        expect(result.rules).toBeDefined();
        expect(Array.isArray(result.rules)).toBe(true);
        expect(result.rules).toHaveLength(2);

        // Verify that content field is excluded from all rules
        for (const rule of result.rules) {
          expect(rule).not.toHaveProperty("content");
          expect(rule).toHaveProperty("id");
          expect(rule).toHaveProperty("name");
          expect(rule).toHaveProperty("description");
          expect(rule).toHaveProperty("format");
          expect(rule).toHaveProperty("path");
        }

        // Verify specific rule properties are preserved
        const firstRule = first(result.rules);
        expect(firstRule.id).toBe("test-rule-1");
        expect(firstRule.name).toBe("Test Rule 1");
        expect(firstRule.tags).toEqual(["test"]);
        expect(firstRule.globs).toEqual(["*.ts"]);

        const secondRule = elementAt(result.rules, 1);
        expect(secondRule.id).toBe("test-rule-2");
        expect(secondRule.name).toBe("Test Rule 2");
      }
    });

    test("should pass through filtering parameters to domain service", async () => {
      const mockRules: unknown[] = [];

      const mockListRules = mock(() =>
        Promise.resolve(mockRules)
      ) as unknown as typeof RuleService.prototype.listRules;
      RuleService.prototype.listRules = mockListRules;

      const command = testRegistry.getCommand("rules.list");
      expect(command).toBeDefined();

      if (command) {
        await command.execute(
          {
            format: "cursor",
            tag: "test-tag",
            json: true,
            debug: true,
          },
          {}
        );

        // Verify that the filtering parameters were passed correctly
        expect(mockListRules).toHaveBeenCalledWith({
          format: "cursor",
          tag: "test-tag",
          debug: true,
        });
      }
    });
  });
});
