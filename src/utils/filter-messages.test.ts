import { describe, expect, test } from "bun:test";
import {
  getStatusFilterMessage,
  getActiveTasksMessage,
  generateFilterMessages,
} from "./filter-messages";
import { expectToHaveLength } from "./test-utils/assertions";

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
      expect(message).toBe("Showing active tasks (use --all to include completed _tasks)");
    });

    test("includes instruction about --all flag", () => {
      const message = getActiveTasksMessage();
      expect(message).toContain("--all");
    });
  });

  describe("generateFilterMessages", () => {
    test("returns status filter message when status is provided", () => {
      const messages = generateFilterMessages({ _status: "IN-PROGRESS" });
      expectToHaveLength(messages, 1);
      expect(messages[0]).toBe("Showing tasks with status 'IN-PROGRESS'");
    });

    test("returns active tasks message when not showing all tasks", () => {
      const messages = generateFilterMessages({ all: false });
      expectToHaveLength(messages, 1);
      expect(messages[0]).toBe("Showing active tasks (use --all to include completed _tasks)");
    });

    test("returns no messages when all is true", () => {
      const messages = generateFilterMessages({ all: true });
      expectToHaveLength(messages, 0);
    });

    test("prioritizes status filter over active tasks message", () => {
      const messages = generateFilterMessages({ _status: "TODO", all: false });
      expectToHaveLength(messages, 1);
      expect(messages[0]).toBe("Showing tasks with status 'TODO'");
    });

    test("returns empty array when no filter options provided", () => {
      const messages = generateFilterMessages({});
      expectToHaveLength(messages, 1);
      expect(messages[0]).toBe("Showing active tasks (use --all to include completed _tasks)");
    });
  });
});
