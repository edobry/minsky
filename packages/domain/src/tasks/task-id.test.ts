import { describe, it, expect } from "bun:test";
import {
  parseTaskId,
  isQualifiedTaskId,
  formatTaskId,
  extractBackend,
  extractLocalId,
  taskIdToSessionId,
  sessionIdToTaskId,
} from "./task-id";

describe("Unified Task ID System", () => {
  describe("parseTaskId", () => {
    it("should parse qualified task IDs correctly", () => {
      const result = parseTaskId("md#123");
      expect(result).toEqual({
        backend: "md",
        localId: "123",
        full: "md#123",
      });
    });

    it("should parse different backend types", () => {
      const mdResult = parseTaskId("md#123");
      const ghResult = parseTaskId("gh#456");

      expect(mdResult).toEqual({
        backend: "md",
        localId: "123",
        full: "md#123",
      });

      expect(ghResult).toEqual({
        backend: "gh",
        localId: "456",
        full: "gh#456",
      });
    });

    it("should handle numeric local IDs", () => {
      const result = parseTaskId("md#42");
      expect(result?.localId).toBe("42");
    });

    it("should handle string local IDs", () => {
      const result = parseTaskId("gh#feature-123");
      expect(result?.localId).toBe("feature-123");
    });

    it("should return null for invalid formats", () => {
      expect(parseTaskId("123")).toBeNull();
      expect(parseTaskId("md#")).toBeNull();
      expect(parseTaskId("#123")).toBeNull();
      expect(parseTaskId("")).toBeNull();
      expect(parseTaskId("md#123#extra")).toBeNull();
    });

    it("should handle complex local IDs with special characters", () => {
      const result = parseTaskId("gh#issue-456-fix");
      expect(result?.localId).toBe("issue-456-fix");
    });
  });

  describe("isQualifiedTaskId", () => {
    it("should return true for qualified task IDs", () => {
      expect(isQualifiedTaskId("md#123")).toBe(true);
      expect(isQualifiedTaskId("gh#456")).toBe(true);
    });

    it("should return false for unqualified IDs", () => {
      expect(isQualifiedTaskId("123")).toBe(false);
      expect(isQualifiedTaskId("456")).toBe(false);
      expect(isQualifiedTaskId("task#123")).toBe(false);
    });

    it("should return false for invalid formats", () => {
      expect(isQualifiedTaskId("")).toBe(false);
      expect(isQualifiedTaskId("md#")).toBe(false);
      expect(isQualifiedTaskId("#123")).toBe(false);
      expect(isQualifiedTaskId("md#123#extra")).toBe(false);
    });
  });

  describe("formatTaskId", () => {
    it("should format backend and local ID correctly", () => {
      expect(formatTaskId("md", "123")).toBe("md#123");
      expect(formatTaskId("gh", "456")).toBe("gh#456");
    });

    it("should handle special characters in local ID", () => {
      expect(formatTaskId("gh", "issue-456")).toBe("gh#issue-456");
    });

    it("should throw for empty backend", () => {
      expect(() => formatTaskId("", "123")).toThrow();
    });

    it("should throw for empty local ID", () => {
      expect(() => formatTaskId("md", "")).toThrow();
    });
  });

  describe("extractBackend", () => {
    it("should extract backend from qualified task IDs", () => {
      expect(extractBackend("md#123")).toBe("md");
      expect(extractBackend("gh#456")).toBe("gh");
    });

    it("should return null for unqualified IDs", () => {
      expect(extractBackend("123")).toBeNull();
      expect(extractBackend("456")).toBeNull();
    });

    it("should return null for invalid formats", () => {
      expect(extractBackend("")).toBeNull();
      expect(extractBackend("md#")).toBeNull();
      expect(extractBackend("#123")).toBeNull();
    });
  });

  describe("extractLocalId", () => {
    it("should extract local ID from qualified task IDs", () => {
      expect(extractLocalId("md#123")).toBe("123");
      expect(extractLocalId("gh#456")).toBe("456");
    });

    it("should return null for unqualified IDs", () => {
      expect(extractLocalId("123")).toBeNull();
      expect(extractLocalId("456")).toBeNull();
    });

    it("should return null for invalid formats", () => {
      expect(extractLocalId("")).toBeNull();
      expect(extractLocalId("md#")).toBeNull();
      expect(extractLocalId("#123")).toBeNull();
    });
  });
});

describe("Session/Branch Conversion", () => {
  describe("taskIdToSessionId", () => {
    it("should convert qualified task IDs to session IDs", () => {
      expect(taskIdToSessionId("md#123")).toBe("task-md#123");
      expect(taskIdToSessionId("gh#456")).toBe("task-gh#456");
    });

    it("should return unqualified IDs as-is", () => {
      expect(taskIdToSessionId("123")).toBe("123");
      expect(taskIdToSessionId("456")).toBe("456");
    });

    it("should handle complex local IDs", () => {
      expect(taskIdToSessionId("gh#issue-456")).toBe("task-gh#issue-456");
    });
  });

  describe("sessionIdToTaskId", () => {
    it("should convert session IDs to task IDs", () => {
      expect(sessionIdToTaskId("task-md#123")).toBe("md#123");
      expect(sessionIdToTaskId("task-gh#456")).toBe("gh#456");
    });

    it("should handle complex local IDs", () => {
      expect(sessionIdToTaskId("task-gh#issue-456")).toBe("gh#issue-456");
    });
  });

  describe("Round-trip conversion", () => {
    it("should maintain consistency through round-trip conversions", () => {
      const taskIds = ["md#123", "gh#456", "gh#issue-456"];

      for (const taskId of taskIds) {
        const sessionId = taskIdToSessionId(taskId);
        const backToTaskId = sessionIdToTaskId(sessionId);
        expect(backToTaskId).toBe(taskId);
      }
    });
  });
});

describe("Edge Cases and Error Handling", () => {
  it("should handle empty strings gracefully", () => {
    expect(parseTaskId("")).toBeNull();
    expect(isQualifiedTaskId("")).toBe(false);
    expect(extractBackend("")).toBeNull();
    expect(extractLocalId("")).toBeNull();
  });

  it("should handle malformed IDs", () => {
    const malformed = ["#", "md#", "#123", "md#123#extra", "md##123"];

    for (const id of malformed) {
      expect(parseTaskId(id)).toBeNull();
      expect(isQualifiedTaskId(id)).toBe(false);
      expect(extractBackend(id)).toBeNull();
      expect(extractLocalId(id)).toBeNull();
    }
  });

  it("should preserve special characters in local IDs", () => {
    const specialIds = ["gh#issue-456", "gh#feature_branch-123", "md#task.with.dots"];

    for (const id of specialIds) {
      const parsed = parseTaskId(id);
      expect(parsed).not.toBeNull();
      expect(parsed?.full).toBe(id);
    }
  });

  it("should handle conversion edge cases", () => {
    expect(taskIdToSessionId("")).toBe("");
    expect(sessionIdToTaskId("")).toBeNull();
    expect(taskIdToSessionId("invalid")).toBe("invalid");
    expect(sessionIdToTaskId("invalid")).toBeNull();
  });
});
