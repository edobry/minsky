import { describe, it, expect } from "bun:test";
import type { SessionRecord } from "./types";
import {
  SessionMultiBackendIntegration,
  type MultiBackendSessionRecord,
} from "./multi-backend-integration";
import { isUuidSessionId } from "../tasks/task-id";

describe("Session Multi-Backend Integration", () => {
  describe("SessionMultiBackendIntegration", () => {
    describe("generateSessionId", () => {
      it("should generate UUID session IDs for qualified task IDs", () => {
        const mdSession = SessionMultiBackendIntegration.generateSessionId("md#123");
        const ghSession = SessionMultiBackendIntegration.generateSessionId("gh#456");
        const jsonSession = SessionMultiBackendIntegration.generateSessionId("json#789");

        // Session IDs are now opaque UUIDs
        expect(isUuidSessionId(mdSession)).toBe(true);
        expect(isUuidSessionId(ghSession)).toBe(true);
        expect(isUuidSessionId(jsonSession)).toBe(true);

        // Each call should produce a unique UUID
        expect(mdSession).not.toBe(ghSession);
        expect(ghSession).not.toBe(jsonSession);
      });

      it("should throw for invalid or legacy IDs", () => {
        expect(() => SessionMultiBackendIntegration.generateSessionId("123")).toThrow();
        expect(() => SessionMultiBackendIntegration.generateSessionId("#123")).toThrow();
        expect(() => SessionMultiBackendIntegration.generateSessionId("task#123")).toThrow();
        expect(() => SessionMultiBackendIntegration.generateSessionId("invalid")).toThrow();
        expect(() => SessionMultiBackendIntegration.generateSessionId("abc123")).toThrow();
      });

      it("should throw for empty task ID", () => {
        expect(() => SessionMultiBackendIntegration.generateSessionId("")).toThrow(
          "Task ID is required"
        );
      });
    });

    describe("extractTaskIdFromSessionId", () => {
      it("should extract qualified task IDs from new format session IDs", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("task-md#123")).toBe(
          "md#123"
        );
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("task-gh#456")).toBe(
          "gh#456"
        );
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("task-json#789")).toBe(
          "json#789"
        );
      });

      it("should return null for legacy session IDs", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("task123")).toBeNull();
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("task#123")).toBeNull();
      });

      it("should return null for invalid session IDs", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("")).toBeNull();
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("invalid")).toBeNull();
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("session123")).toBeNull();
      });

      it("should handle complex local IDs", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("task-gh#issue-456")).toBe(
          "gh#issue-456"
        );
      });
    });

    describe("enhanceSessionRecord", () => {
      it("should enhance records with qualified task IDs", () => {
        const sessionRecord: SessionRecord = {
          sessionId: "task-md#123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123",
        };

        const enhanced = SessionMultiBackendIntegration.enhanceSessionRecord(sessionRecord);

        expect(enhanced.taskBackend).toBe("md");
        expect(enhanced.taskId).toBe("md#123");
        expect(enhanced.legacyTaskId).toBeUndefined();
      });

      it("should passthrough legacy records without enrichment", () => {
        const sessionRecord: SessionRecord = {
          sessionId: "task123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        };

        const enhanced = SessionMultiBackendIntegration.enhanceSessionRecord(sessionRecord);

        expect(enhanced.taskBackend).toBeUndefined();
        expect(enhanced.taskId).toBe("123");
        expect(enhanced.legacyTaskId).toBeUndefined();
      });

      it("should handle records without task IDs", () => {
        const sessionRecord: SessionRecord = {
          sessionId: "custom-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
        };

        const enhanced = SessionMultiBackendIntegration.enhanceSessionRecord(sessionRecord);

        expect(enhanced.taskBackend).toBeUndefined();
        expect(enhanced.taskId).toBeUndefined();
        expect(enhanced.legacyTaskId).toBeUndefined();
      });

      it("should handle different backend types", () => {
        const ghSessionRecord: SessionRecord = {
          sessionId: "task-gh#456",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "gh#456",
        };

        const enhanced = SessionMultiBackendIntegration.enhanceSessionRecord(ghSessionRecord);

        expect(enhanced.taskBackend).toBe("gh");
        expect(enhanced.taskId).toBe("gh#456");
      });
    });

    describe("isMultiBackendSessionId", () => {
      it("should identify UUID session IDs as multi-backend", () => {
        expect(
          SessionMultiBackendIntegration.isMultiBackendSessionId(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
          )
        ).toBe(true);
      });

      it("should identify legacy new format session IDs", () => {
        expect(SessionMultiBackendIntegration.isMultiBackendSessionId("task-md#123")).toBe(true);
        expect(SessionMultiBackendIntegration.isMultiBackendSessionId("task-gh#456")).toBe(true);
        expect(SessionMultiBackendIntegration.isMultiBackendSessionId("task-json#789")).toBe(true);
      });

      it("should identify legacy format session IDs", () => {
        expect(SessionMultiBackendIntegration.isMultiBackendSessionId("task123")).toBe(false);
        expect(SessionMultiBackendIntegration.isMultiBackendSessionId("task#123")).toBe(false);
        expect(SessionMultiBackendIntegration.isMultiBackendSessionId("custom-session")).toBe(
          false
        );
      });
    });

    // migrateLegacySessionRecord removed in strict-only mode

    // getDisplayTaskId removed

    describe("validateSessionTaskCompatibility", () => {
      it("should validate compatible session IDs and task IDs", () => {
        expect(
          SessionMultiBackendIntegration.validateSessionTaskCompatibility("task-md#123", "md#123")
        ).toBe(true);

        expect(
          SessionMultiBackendIntegration.validateSessionTaskCompatibility("task-gh#456", "gh#456")
        ).toBe(true);
      });

      it("should detect incompatible session IDs and task IDs", () => {
        expect(
          SessionMultiBackendIntegration.validateSessionTaskCompatibility("task-md#123", "gh#456")
        ).toBe(false);

        expect(
          SessionMultiBackendIntegration.validateSessionTaskCompatibility("task123", "gh#456")
        ).toBe(false);
      });
    });

    describe("getTaskBackend", () => {
      it("should extract backend from enhanced records", () => {
        const enhanced: MultiBackendSessionRecord = {
          sessionId: "task-md#123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123",
          taskBackend: "md",
        };

        expect(SessionMultiBackendIntegration.getTaskBackend(enhanced)).toBe("md");
      });

      it("should extract backend from qualified task IDs", () => {
        const record: SessionRecord = {
          sessionId: "task-gh#456",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "gh#456",
        };

        expect(SessionMultiBackendIntegration.getTaskBackend(record)).toBe("gh");
      });

      it("should default to markdown for legacy records", () => {
        const record: SessionRecord = {
          sessionId: "task123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        };

        expect(SessionMultiBackendIntegration.getTaskBackend(record)).toBe("md");
      });

      it("should return null for records without task IDs", () => {
        const record: SessionRecord = {
          sessionId: "custom-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
        };

        expect(SessionMultiBackendIntegration.getTaskBackend(record)).toBeNull();
      });
    });
  });

  // SessionBackwardCompatibility removed in strict-only mode

  describe("Integration scenarios", () => {
    it("should generate UUID session IDs that don't encode task IDs", () => {
      const taskIds = ["md#123", "gh#456", "json#789"];

      for (const taskId of taskIds) {
        const sessionId = SessionMultiBackendIntegration.generateSessionId(taskId);

        // Session IDs are now UUIDs — they don't encode task IDs
        expect(isUuidSessionId(sessionId)).toBe(true);
        // UUID session IDs return null from extractTaskIdFromSessionId
        // (task linkage is via SessionRecord.taskId, not the session ID)
        const extractedTaskId =
          SessionMultiBackendIntegration.extractTaskIdFromSessionId(sessionId);
        expect(extractedTaskId).toBeNull();
      }
    });

    it("should still extract task IDs from legacy session IDs", () => {
      // Legacy format still works for backward compat
      expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("task-md#123")).toBe(
        "md#123"
      );
      expect(SessionMultiBackendIntegration.extractTaskIdFromSessionId("task-gh#456")).toBe(
        "gh#456"
      );
    });

    // Migration consistency tests removed in strict-only mode
  });
});
