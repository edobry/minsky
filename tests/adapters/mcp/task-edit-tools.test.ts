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
 *
 * Resolves the lazy `getHandler` thunks (mt#1792) into concrete handler
 * functions — the command objects expose `getHandler`, not `handler`, so the
 * real-handler tests must await the thunk to get the dispatch function.
 */
async function buildMockSetup(initialSpec: string) {
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

  const resolveHandler = async (name: string) => {
    const cmd = registeredTools[name];
    return cmd.handler ?? (await cmd.getHandler());
  };

  return {
    handler: await resolveHandler("tasks.spec.search_replace"),
    patchHandler: await resolveHandler("tasks.spec.patch"),
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

      const { handler, getStoredSpec } = await buildMockSetup(originalSpec);

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

      const { handler, getStoredSpec } = await buildMockSetup(originalSpec);

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
      const { handler } = await buildMockSetup("Some spec content without the search text");

      const result = await handler({
        taskId: "mt#1361",
        search: "nonexistent text",
        replace: "replacement",
      });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("Search text not found");
    });

    test("should error when search text found more than once", async () => {
      const { handler } = await buildMockSetup("foo bar foo");

      const result = await handler({
        taskId: "mt#1361",
        search: "foo",
        replace: "baz",
      });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("found 2 times");
    });

    test("mt#2408: empty search string is rejected fast (no hang) and leaves the spec intact", async () => {
      const original = "## Summary\n\nfoo bar foo";
      const { handler, getStoredSpec } = await buildMockSetup(original);

      const result = await handler({
        taskId: "mt#2408",
        search: "",
        replace: "baz",
      });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("non-empty");
      expect(getStoredSpec()).toBe(original);
    });
  });

  describe("tasks.spec.patch — mt#2400 fail-closed guard", () => {
    test("marker-less content on a non-empty spec is refused and leaves the spec intact", async () => {
      const originalSpec =
        "## Summary\n\nThe whole original spec body.\n\n## Success Criteria\n\n- One\n- Two";
      const { patchHandler, getStoredSpec } = await buildMockSetup(originalSpec);

      const result = await patchHandler({
        taskId: "mt#2400",
        content: "## Replacement\n\nJust this chunk, no markers.",
      });

      // The handler returns a structured error envelope rather than throwing.
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("Refusing to patch");
      expect(String(result.error)).toContain("tasks_edit");
      // Critical: the original spec must NOT have been overwritten.
      expect(getStoredSpec()).toBe(originalSpec);
    });

    test("marker-less content on an empty/new spec is allowed (creates the spec)", async () => {
      const { patchHandler, getStoredSpec } = await buildMockSetup("");

      const newBody = "## Summary\n\nBrand-new spec content.";
      const result = await patchHandler({
        taskId: "mt#2400",
        content: newBody,
      });

      expect(result.success).toBe(true);
      expect(getStoredSpec()).toBe(newBody);
    });

    test("marker content on a non-existent spec still errors (pre-existing guard preserved)", async () => {
      const { patchHandler } = await buildMockSetup("");

      const result = await patchHandler({
        taskId: "mt#2400",
        content: "// ... existing code ...\n## New\nstuff",
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("existing code markers");
    });
  });
});
