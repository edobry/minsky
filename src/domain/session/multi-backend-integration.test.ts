import { describe, it, expect } from "bun:test";
import type { SessionRecord } from "./types";
import {
  SessionMultiBackendIntegration,
  type MultiBackendSessionRecord,
} from "./multi-backend-integration";
import { isUuidSessionName } from "../tasks/task-id";

describe("Session Multi-Backend Integration", () => {
  describe("SessionMultiBackendIntegration", () => {
    describe("generateSessionName", () => {
      it("should generate UUID session names for qualified task IDs", () => {
        const mdSession = SessionMultiBackendIntegration.generateSessionName("md#123");
        const ghSession = SessionMultiBackendIntegration.generateSessionName("gh#456");
        const jsonSession = SessionMultiBackendIntegration.generateSessionName("json#789");

        // Session names are now opaque UUIDs
        expect(isUuidSessionName(mdSession)).toBe(true);
        expect(isUuidSessionName(ghSession)).toBe(true);
        expect(isUuidSessionName(jsonSession)).toBe(true);

        // Each call should produce a unique UUID
        expect(mdSession).not.toBe(ghSession);
        expect(ghSession).not.toBe(jsonSession);
      });

      it("should throw for invalid or legacy IDs", () => {
        expect(() => SessionMultiBackendIntegration.generateSessionName("123")).toThrow();
        expect(() => SessionMultiBackendIntegration.generateSessionName("#123")).toThrow();
        expect(() => SessionMultiBackendIntegration.generateSessionName("task#123")).toThrow();
        expect(() => SessionMultiBackendIntegration.generateSessionName("invalid")).toThrow();
        expect(() => SessionMultiBackendIntegration.generateSessionName("abc123")).toThrow();
      });

      it("should throw for empty task ID", () => {
        expect(() => SessionMultiBackendIntegration.generateSessionName("")).toThrow(
          "Task ID is required"
        );
      });
    });

    describe("extractTaskIdFromSessionName", () => {
      it("should extract qualified task IDs from new format session names", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task-md#123")).toBe(
          "md#123"
        );
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task-gh#456")).toBe(
          "gh#456"
        );
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task-json#789")).toBe(
          "json#789"
        );
      });

      it("should return null for legacy session names", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task123")).toBeNull();
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task#123")).toBeNull();
      });

      it("should return null for invalid session names", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("")).toBeNull();
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("invalid")).toBeNull();
        expect(
          SessionMultiBackendIntegration.extractTaskIdFromSessionName("session123")
        ).toBeNull();
      });

      it("should handle complex local IDs", () => {
        expect(
          SessionMultiBackendIntegration.extractTaskIdFromSessionName("task-gh#issue-456")
        ).toBe("gh#issue-456");
      });
    });

    describe("enhanceSessionRecord", () => {
      it("should enhance records with qualified task IDs", () => {
        const sessionRecord: SessionRecord = {
          session: "task-md#123",
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
          session: "task123",
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
          session: "custom-session",
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
          session: "task-gh#456",
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

    describe("isMultiBackendSessionName", () => {
      it("should identify UUID session names as multi-backend", () => {
        expect(
          SessionMultiBackendIntegration.isMultiBackendSessionName(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
          )
        ).toBe(true);
      });

      it("should identify legacy new format session names", () => {
        expect(SessionMultiBackendIntegration.isMultiBackendSessionName("task-md#123")).toBe(true);
        expect(SessionMultiBackendIntegration.isMultiBackendSessionName("task-gh#456")).toBe(true);
        expect(SessionMultiBackendIntegration.isMultiBackendSessionName("task-json#789")).toBe(
          true
        );
      });

      it("should identify legacy format session names", () => {
        expect(SessionMultiBackendIntegration.isMultiBackendSessionName("task123")).toBe(false);
        expect(SessionMultiBackendIntegration.isMultiBackendSessionName("task#123")).toBe(false);
        expect(SessionMultiBackendIntegration.isMultiBackendSessionName("custom-session")).toBe(
          false
        );
      });
    });

    // migrateLegacySessionRecord removed in strict-only mode

    // getDisplayTaskId removed

    describe("validateSessionTaskCompatibility", () => {
      it("should validate compatible session names and task IDs", () => {
        expect(
          SessionMultiBackendIntegration.validateSessionTaskCompatibility("task-md#123", "md#123")
        ).toBe(true);

        expect(
          SessionMultiBackendIntegration.validateSessionTaskCompatibility("task-gh#456", "gh#456")
        ).toBe(true);
      });

      it("should detect incompatible session names and task IDs", () => {
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
          session: "task-md#123",
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
          session: "task-gh#456",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "gh#456",
        };

        expect(SessionMultiBackendIntegration.getTaskBackend(record)).toBe("gh");
      });

      it("should default to markdown for legacy records", () => {
        const record: SessionRecord = {
          session: "task123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        };

        expect(SessionMultiBackendIntegration.getTaskBackend(record)).toBe("md");
      });

      it("should return null for records without task IDs", () => {
        const record: SessionRecord = {
          session: "custom-session",
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
    it("should generate UUID session names that don't encode task IDs", () => {
      const taskIds = ["md#123", "gh#456", "json#789"];

      for (const taskId of taskIds) {
        const sessionId = SessionMultiBackendIntegration.generateSessionName(taskId);

        // Session names are now UUIDs — they don't encode task IDs
        expect(isUuidSessionName(sessionId)).toBe(true);
        // UUID session names return null from extractTaskIdFromSessionName
        // (task linkage is via SessionRecord.taskId, not the session name)
        const extractedTaskId =
          SessionMultiBackendIntegration.extractTaskIdFromSessionName(sessionId);
        expect(extractedTaskId).toBeNull();
      }
    });

    it("should still extract task IDs from legacy session names", () => {
      // Legacy format still works for backward compat
      expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task-md#123")).toBe(
        "md#123"
      );
      expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task-gh#456")).toBe(
        "gh#456"
      );
    });

    // Migration consistency tests removed in strict-only mode
  });
});
