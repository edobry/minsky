import { expect, describe, test } from "bun:test";
import {
  getStatusFilterMessage,
  getActiveTasksMessage,
  generateFilterMessages,
} from "./filter-messages";

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
      expect(message).toBe("Showing active tasks (use --all to include completed tasks)");
    });

    test("includes instruction about --all flag", () => {
      const message = getActiveTasksMessage();
      expect(message).toContain("--all");
    });
  });

  describe("generateFilterMessages", () => {
    test("returns status filter message when status is provided", () => {
      const messages = generateFilterMessages({ status: "IN-PROGRESS" });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe("Showing tasks with status 'IN-PROGRESS'");
    });

    test("returns active tasks message when not showing all tasks", () => {
      const messages = generateFilterMessages({ all: false });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe("Showing active tasks (use --all to include completed tasks)");
    });

    test("returns no messages when all is true", () => {
      const messages = generateFilterMessages({ all: true });
      expect(messages).toHaveLength(0);
    });

    test("prioritizes status filter over active tasks message", () => {
      const messages = generateFilterMessages({ status: "TODO", all: false });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe("Showing tasks with status 'TODO'");
    });

    test("returns empty array when no filter options provided", () => {
      const messages = generateFilterMessages({});
      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe("Showing active tasks (use --all to include completed tasks)");
    });
  });
});
