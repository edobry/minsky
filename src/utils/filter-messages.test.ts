import { describe, expect, test } from "bun:test";
import {
  getStatusFilterMessage,
  getActiveTasksMessage,
  generateFilterMessages,
} from "./filter-messages";
import { expectToHaveLength } from "./test-utils/assertions";
import { UI_TEST_PATTERNS } from "./test-utils/test-constants";

describe("Filter Messages Utility", () => {
  describe("getStatusFilterMessage", () => {
    test("returns correct message for a given status", () => {
      const message = getStatusFilterMessage("IN-PROGRESS");
      expect(message).toBe("Showing tasks with status 'IN-PROGRESS'");
    });

    test("includes the status in single quotes", () => {
      const message = getStatusFilterMessage("DONE");
      expect(message).toContain("'DONE'");
    });
  });

  describe("getActiveTasksMessage", () => {
    test("returns message about active tasks", () => {
      const message = getActiveTasksMessage();
      expect(message).toBe(UI_TEST_PATTERNS.SHOWING_ACTIVE_TASKS);
    });

    test("includes instruction about --all flag", () => {
      const message = getActiveTasksMessage();
      expect(message).toContain("--all");
    });
  });

  describe("generateFilterMessages", () => {
    test("returns status filter message when status is provided", () => {
      const messages = generateFilterMessages({ status: "IN-PROGRESS" });
      expectToHaveLength(messages, 1);
      expect(messages[0]).toBe("Showing tasks with status 'IN-PROGRESS'");
    });

    test("returns active tasks message when not showing all tasks", () => {
      const messages = generateFilterMessages({ all: false });
      expectToHaveLength(messages, 1);
      expect(messages[0]).toBe(UI_TEST_PATTERNS.SHOWING_ACTIVE_TASKS);
    });

    test("returns no messages when all is true", () => {
      const messages = generateFilterMessages({ all: true });
      expectToHaveLength(messages, 0);
    });

    test("prioritizes status filter over active tasks message", () => {
      const messages = generateFilterMessages({ status: "TODO", all: false });
      expectToHaveLength(messages, 1);
      expect(messages[0]).toBe("Showing tasks with status 'TODO'");
    });

    test("returns empty array when no filter options provided", () => {
      const messages = generateFilterMessages({});
      expectToHaveLength(messages, 1);
      expect(messages[0]).toBe(UI_TEST_PATTERNS.SHOWING_ACTIVE_TASKS);
    });
  });
});
