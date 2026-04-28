/**
 * Tests for task-aware edit tools (tasks.spec.search_replace)
 *
 * Regression tests for the dollar-pattern substitution bug (mt#1361):
 * String.prototype.replace() processes special $-sequences in the replace string
 * even when the search value is a plain string. The fix uses the function-replacer
 * overload which bypasses this processing.
 */
import { describe, test, expect } from "bun:test";
import { setupTestMocks } from "../../../src/utils/test-utils/mocking";

setupTestMocks();

import { registerTaskEditTools } from "../../../src/adapters/mcp/task-edit-tools";

/**
 * Build a mock container + mock task service that stores spec content in memory.
 */
function buildMockSetup(initialSpec: string) {
  let storedSpec = initialSpec;

  const mockTaskService = {
    getTaskSpecContent: async (_taskId: string) => ({ content: storedSpec }),
    updateTask: async (_taskId: string, updates: Record<string, unknown>) => {
      if (typeof updates["spec"] === "string") {
        storedSpec = updates["spec"];
      }
    },
    // Minimal no-op stubs for other required methods
    listTasks: async () => [],
    getTask: async () => null,
    createTask: async () => ({ id: "mt#0" }),
    deleteTask: async () => false,
    setTaskStatus: async () => {},
    listBackends: () => [],
  };

  const mockContainer = {
    has: (key: string) => key === "persistence" || key === "taskService",
    get: (key: string) => {
      if (key === "taskService") return mockTaskService;
      if (key === "persistence") return {};
      throw new Error(`Unknown service: ${key}`);
    },
  };

  const registeredTools: any = {};
  const mockCommandMapper = {
    addCommand: (command: any) => {
      registeredTools[command.name] = command;
    },
  };

  registerTaskEditTools(mockCommandMapper as any, mockContainer as any);

  return {
    handler: registeredTools["tasks.spec.search_replace"].handler,
    getStoredSpec: () => storedSpec,
  };
}

describe("task-edit-tools", () => {
  describe("tasks.spec.search_replace", () => {
    test("should replace text literally when replace string contains dollar-backtick sequence", async () => {
      // Regression: the dollar-backtick sequence in a replace string was previously
      // interpreted as the JS replacement pattern "string before match", causing
      // surrounding content to be spliced into each replacement.
      const searchToken = "SEARCH_TOKEN";
      // dollar-backtick: the character after the dollar is a backtick
      const replaceText = "see `$`[-_]key` for details";
      const originalSpec = `## Summary\n\n${searchToken}\n\n## Details\n\nSome detail text`;

      const { handler, getStoredSpec } = buildMockSetup(originalSpec);

      const result = await handler({
        taskId: "mt#1361",
        search: searchToken,
        replace: replaceText,
      });

      expect(result.success).toBe(true);

      // Use split/join to compute the expected literal replacement — not String.prototype.replace,
      // which would itself expand the dollar-backtick pattern.
      const expected = originalSpec.split(searchToken).join(replaceText);
      expect(getStoredSpec()).toBe(expected);
      // Dollar-backtick must not have been expanded: the spec content must contain
      // the literal replace text, not interpolated prefix content.
      expect(getStoredSpec()).toContain(replaceText);
      expect(getStoredSpec()).not.toContain("see `## Summary");
    });

    test("should replace text literally when replace string contains dollar-ampersand", async () => {
      // dollar-ampersand in JS replace() normally expands to the matched substring.
      // The function-replacer fix must prevent this.
      const searchToken = "TARGET_TEXT";
      // Without the fix: "$&-suffix" would expand to "TARGET_TEXT-suffix"
      const replaceText = "$&-literal-suffix";
      const originalSpec = `Start\n${searchToken}\nEnd`;

      const { handler, getStoredSpec } = buildMockSetup(originalSpec);

      const result = await handler({
        taskId: "mt#1361",
        search: searchToken,
        replace: replaceText,
      });

      expect(result.success).toBe(true);

      // Must be literal: dollar-ampersand not expanded to the matched text.
      const expected = `Start\n${replaceText}\nEnd`;
      expect(getStoredSpec()).toBe(expected);
    });

    test("should error when search text not found", async () => {
      const { handler } = buildMockSetup("Some spec content without the search text");

      await expect(
        handler({
          taskId: "mt#1361",
          search: "nonexistent text",
          replace: "replacement",
        })
      ).rejects.toThrow("Search text not found");
    });

    test("should error when search text found more than once", async () => {
      const { handler } = buildMockSetup("foo bar foo");

      await expect(
        handler({
          taskId: "mt#1361",
          search: "foo",
          replace: "baz",
        })
      ).rejects.toThrow("found 2 times");
    });
  });
});
