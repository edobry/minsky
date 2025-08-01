import { describe, it, expect } from "bun:test";
import type { SessionRecord } from "./types";
import {
  SessionMultiBackendIntegration,
  SessionBackwardCompatibility,
  type MultiBackendSessionRecord,
} from "./multi-backend-integration";

describe("Session Multi-Backend Integration", () => {
  describe("SessionMultiBackendIntegration", () => {
    describe("generateSessionName", () => {
      it("should generate session names for qualified task IDs", () => {
        expect(SessionMultiBackendIntegration.generateSessionName("md#123")).toBe("task-md#123");
        expect(SessionMultiBackendIntegration.generateSessionName("gh#456")).toBe("task-gh#456");
        expect(SessionMultiBackendIntegration.generateSessionName("json#789")).toBe(
          "task-json#789"
        );
      });

      it("should migrate legacy numeric IDs to markdown backend", () => {
        expect(SessionMultiBackendIntegration.generateSessionName("123")).toBe("task-md#123");
        expect(SessionMultiBackendIntegration.generateSessionName("456")).toBe("task-md#456");
      });

      it("should handle display format IDs", () => {
        expect(SessionMultiBackendIntegration.generateSessionName("#123")).toBe("task-md#123");
        expect(SessionMultiBackendIntegration.generateSessionName("#456")).toBe("task-md#456");
      });

      it("should handle task# format IDs", () => {
        expect(SessionMultiBackendIntegration.generateSessionName("task#123")).toBe("task-md#123");
        expect(SessionMultiBackendIntegration.generateSessionName("task#456")).toBe("task-md#456");
      });

      it("should fallback to legacy format for invalid IDs", () => {
        expect(SessionMultiBackendIntegration.generateSessionName("invalid")).toBe("taskinvalid");
        expect(SessionMultiBackendIntegration.generateSessionName("abc123")).toBe("taskabc123");
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

      it("should migrate legacy numeric session names", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task123")).toBe(
          "md#123"
        );
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task456")).toBe(
          "md#456"
        );
      });

      it("should handle legacy task# format session names", () => {
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task#123")).toBe(
          "md#123"
        );
        expect(SessionMultiBackendIntegration.extractTaskIdFromSessionName("task#456")).toBe(
          "md#456"
        );
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

      it("should enhance legacy records and migrate task IDs", () => {
        const sessionRecord: SessionRecord = {
          session: "task123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        };

        const enhanced = SessionMultiBackendIntegration.enhanceSessionRecord(sessionRecord);

        expect(enhanced.taskBackend).toBe("md");
        expect(enhanced.taskId).toBe("md#123");
        expect(enhanced.legacyTaskId).toBe("123");
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
      it("should identify new format session names", () => {
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

    describe("migrateLegacySessionRecord", () => {
      it("should migrate legacy session names to new format", () => {
        const legacyRecord: SessionRecord = {
          session: "task123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        };

        const migrated = SessionMultiBackendIntegration.migrateLegacySessionRecord(legacyRecord);

        expect(migrated.session).toBe("task-md#123");
        expect(migrated.taskId).toBe("md#123");
        expect(migrated.taskBackend).toBe("md");
        expect(migrated.legacyTaskId).toBe("123");
      });

      it("should not change already migrated records", () => {
        const modernRecord: SessionRecord = {
          session: "task-md#123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123",
        };

        const result = SessionMultiBackendIntegration.migrateLegacySessionRecord(modernRecord);

        expect(result.session).toBe("task-md#123");
        expect(result.taskId).toBe("md#123");
        expect(result.taskBackend).toBe("md");
      });
    });

    describe("getDisplayTaskId", () => {
      it("should return qualified IDs as-is", () => {
        const record: SessionRecord = {
          session: "task-md#123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123",
        };

        expect(SessionMultiBackendIntegration.getDisplayTaskId(record)).toBe("md#123");
      });

      it("should format legacy IDs for display", () => {
        const record: SessionRecord = {
          session: "task123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        };

        expect(SessionMultiBackendIntegration.getDisplayTaskId(record)).toBe("#123");
      });

      it("should handle records without task IDs", () => {
        const record: SessionRecord = {
          session: "custom-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
        };

        expect(SessionMultiBackendIntegration.getDisplayTaskId(record)).toBe("");
      });
    });

    describe("validateSessionTaskCompatibility", () => {
      it("should validate compatible session names and task IDs", () => {
        expect(
          SessionMultiBackendIntegration.validateSessionTaskCompatibility("task-md#123", "md#123")
        ).toBe(true);

        expect(
          SessionMultiBackendIntegration.validateSessionTaskCompatibility("task-md#123", "123")
        ).toBe(true); // Legacy ID should migrate to md#123

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

  describe("SessionBackwardCompatibility", () => {
    describe("toStorageFormat", () => {
      it("should keep qualified IDs as-is", () => {
        expect(SessionBackwardCompatibility.toStorageFormat("md#123")).toBe("md#123");
        expect(SessionBackwardCompatibility.toStorageFormat("gh#456")).toBe("gh#456");
      });

      it("should normalize legacy IDs", () => {
        expect(SessionBackwardCompatibility.toStorageFormat("#123")).toBe("123");
        expect(SessionBackwardCompatibility.toStorageFormat("task#456")).toBe("456");
        expect(SessionBackwardCompatibility.toStorageFormat("789")).toBe("789");
      });

      it("should handle invalid IDs gracefully", () => {
        expect(SessionBackwardCompatibility.toStorageFormat("invalid")).toBe("invalid");
      });
    });

    describe("toDisplayFormat", () => {
      it("should keep qualified IDs as-is", () => {
        expect(SessionBackwardCompatibility.toDisplayFormat("md#123")).toBe("md#123");
        expect(SessionBackwardCompatibility.toDisplayFormat("gh#456")).toBe("gh#456");
      });

      it("should format legacy IDs for display", () => {
        expect(SessionBackwardCompatibility.toDisplayFormat("123")).toBe("#123");
        expect(SessionBackwardCompatibility.toDisplayFormat("456")).toBe("#456");
      });
    });

    describe("needsMigration", () => {
      it("should identify legacy records that need migration", () => {
        const legacyRecord: SessionRecord = {
          session: "task123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        };

        expect(SessionBackwardCompatibility.needsMigration(legacyRecord)).toBe(true);
      });

      it("should not flag modern records for migration", () => {
        const modernRecord: SessionRecord = {
          session: "task-md#123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123",
        };

        expect(SessionBackwardCompatibility.needsMigration(modernRecord)).toBe(false);
      });

      it("should not flag records without task IDs", () => {
        const customRecord: SessionRecord = {
          session: "custom-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
        };

        expect(SessionBackwardCompatibility.needsMigration(customRecord)).toBe(false);
      });
    });
  });

  describe("Integration scenarios", () => {
    it("should handle round-trip session creation and extraction", () => {
      const taskIds = ["md#123", "gh#456", "json#789", "123", "#123", "task#123"];

      for (const taskId of taskIds) {
        const sessionName = SessionMultiBackendIntegration.generateSessionName(taskId);
        const extractedTaskId =
          SessionMultiBackendIntegration.extractTaskIdFromSessionName(sessionName);

        // Should be able to extract a task ID
        expect(extractedTaskId).not.toBeNull();

        // For legacy IDs, should be migrated to qualified format
        if (taskId === "123" || taskId === "#123" || taskId === "task#123") {
          expect(extractedTaskId).toBe("md#123");
          expect(sessionName).toBe("task-md#123");
        } else {
          expect(extractedTaskId).toBe(taskId);
        }
      }
    });

    it("should maintain data consistency through migration", () => {
      const legacyRecord: SessionRecord = {
        session: "task123",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: "2024-01-01T00:00:00Z",
        taskId: "123",
      };

      // Migrate record
      const migrated = SessionMultiBackendIntegration.migrateLegacySessionRecord(legacyRecord);

      // Verify migration results
      expect(migrated.session).toBe("task-md#123");
      expect(migrated.taskId).toBe("md#123");
      expect(migrated.taskBackend).toBe("md");
      expect(migrated.legacyTaskId).toBe("123");

      // Verify compatibility
      expect(
        SessionMultiBackendIntegration.validateSessionTaskCompatibility(
          migrated.session,
          migrated.taskId!
        )
      ).toBe(true);

      // Verify display format
      expect(SessionMultiBackendIntegration.getDisplayTaskId(migrated)).toBe("md#123");

      // Verify backend extraction
      expect(SessionMultiBackendIntegration.getTaskBackend(migrated)).toBe("md");
    });
  });
});
