/**
 * Tests for Session Task Association Management
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  updateSessionTaskAssociation,
  findSessionsByTaskId,
  hasSessionsForTask,
} from "./session-task-association";
import type { SessionProviderInterface, SessionRecord } from "./types";

// Mock session data
const mockSessions: SessionRecord[] = [
  {
    session: "task-md#123-session",
    repoName: "test-repo",
    repoUrl: "https://github.com/test/repo.git",
    createdAt: "2023-01-01T00:00:00Z",
    taskId: "123", // Plain format without prefix
  },
  {
    session: "another-session",
    repoName: "test-repo",
    repoUrl: "https://github.com/test/repo.git",
    createdAt: "2023-01-01T00:00:00Z",
    taskId: "456",
  },
  {
    session: "unrelated-session",
    repoName: "test-repo",
    repoUrl: "https://github.com/test/repo.git",
    createdAt: "2023-01-01T00:00:00Z",
    taskId: "999",
  },
];

// Mock session provider
const createMockSessionProvider = (): SessionProviderInterface => ({
  listSessions: mock(() => Promise.resolve([...mockSessions])),
  getSession: mock(() => Promise.resolve(mockSessions[0])),
  addSession: mock(() => Promise.resolve()),
  updateSession: mock(() => Promise.resolve()),
  deleteSession: mock(() => Promise.resolve(true)),
  getSessionWorkdir: mock(() => Promise.resolve("/fake/path")),
});

describe("Session Task Association", () => {
  let mockProvider: SessionProviderInterface;

  beforeEach(() => {
    mockProvider = createMockSessionProvider();
    // Reset the mock sessions to original state
    mockSessions[0].taskId = "123";
    mockSessions[1].taskId = "456";
  });

  describe("updateSessionTaskAssociation", () => {
    test("should update session with matching task ID", async () => {
      const result = await updateSessionTaskAssociation("md#123", "mt#123", {
        sessionProvider: mockProvider,
        dryRun: false,
      });

      expect(result.sessionsFound).toBe(1);
      expect(result.sessionsUpdated).toBe(1);
      expect(result.updatedSessions).toEqual(["task-md#123-session"]);
      expect(result.errors).toEqual([]);

      // Verify updateSession was called with correct parameters
      expect(mockProvider.updateSession).toHaveBeenCalledWith("task-md#123-session", {
        taskId: "123", // Should use the new local ID
      });
    });

    test("should update multiple sessions with same task ID", async () => {
      // Add another session with same task ID
      const extraSession: SessionRecord = {
        session: "duplicate-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo.git",
        createdAt: "2023-01-01T00:00:00Z",
        taskId: "123",
      };

      mockProvider.listSessions = mock(() => Promise.resolve([...mockSessions, extraSession]));

      const result = await updateSessionTaskAssociation("md#123", "mt#123", {
        sessionProvider: mockProvider,
        dryRun: false,
      });

      expect(result.sessionsFound).toBe(2);
      expect(result.sessionsUpdated).toBe(2);
      expect(result.updatedSessions).toEqual(["task-md#123-session", "duplicate-session"]);
      expect(result.errors).toEqual([]);
    });

    test("should handle dry-run mode", async () => {
      const result = await updateSessionTaskAssociation("md#123", "mt#123", {
        sessionProvider: mockProvider,
        dryRun: true,
      });

      expect(result.sessionsFound).toBe(1);
      expect(result.sessionsUpdated).toBe(1); // Should still count in dry-run
      expect(result.updatedSessions).toEqual(["task-md#123-session"]);
      expect(result.errors).toEqual([]);

      // Verify updateSession was NOT called in dry-run mode
      expect(mockProvider.updateSession).not.toHaveBeenCalled();
    });

    test("should handle no matching sessions", async () => {
      const result = await updateSessionTaskAssociation("md#999", "mt#999", {
        sessionProvider: mockProvider,
        dryRun: false,
      });

      expect(result.sessionsFound).toBe(1); // There is a session with task ID 999
      expect(result.sessionsUpdated).toBe(1);
      expect(result.updatedSessions).toEqual(["unrelated-session"]);
      expect(result.errors).toEqual([]);
    });

    test("should handle nonexistent task ID", async () => {
      const result = await updateSessionTaskAssociation("md#999999", "mt#999999", {
        sessionProvider: mockProvider,
        dryRun: false,
      });

      expect(result.sessionsFound).toBe(0);
      expect(result.sessionsUpdated).toBe(0);
      expect(result.updatedSessions).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    test("should handle invalid task ID format", async () => {
      const result = await updateSessionTaskAssociation("invalid-id", "mt#123", {
        sessionProvider: mockProvider,
        dryRun: false,
      });

      expect(result.sessionsFound).toBe(0);
      expect(result.sessionsUpdated).toBe(0);
      expect(result.updatedSessions).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain("Invalid task ID format");
    });

    test("should handle session provider errors", async () => {
      mockProvider.updateSession = mock(() => Promise.reject(new Error("Database error")));

      const result = await updateSessionTaskAssociation("md#123", "mt#123", {
        sessionProvider: mockProvider,
        dryRun: false,
      });

      expect(result.sessionsFound).toBe(1);
      expect(result.sessionsUpdated).toBe(0);
      expect(result.updatedSessions).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain("Failed to update session task-md#123-session");
    });

    test("should handle same old and new task IDs (no change needed)", async () => {
      const result = await updateSessionTaskAssociation("md#123", "md#123", {
        sessionProvider: mockProvider,
        dryRun: false,
      });

      expect(result.sessionsFound).toBe(1);
      expect(result.sessionsUpdated).toBe(1);
      expect(result.updatedSessions).toEqual(["task-md#123-session"]);
      expect(result.errors).toEqual([]);

      // Should still call updateSession with the same ID (no harm)
      expect(mockProvider.updateSession).toHaveBeenCalledWith("task-md#123-session", {
        taskId: "123",
      });
    });
  });

  describe("findSessionsByTaskId", () => {
    test("should find sessions by qualified task ID", async () => {
      const sessions = await findSessionsByTaskId("md#123", mockProvider);
      expect(sessions).toEqual(["task-md#123-session"]);
    });

    test("should find sessions by plain task ID", async () => {
      const sessions = await findSessionsByTaskId("123", mockProvider);
      expect(sessions).toEqual(["task-md#123-session"]);
    });

    test("should return empty array for nonexistent task", async () => {
      const sessions = await findSessionsByTaskId("md#999999", mockProvider);
      expect(sessions).toEqual([]);
    });

    test("should handle invalid task ID format", async () => {
      const sessions = await findSessionsByTaskId("invalid-id", mockProvider);
      expect(sessions).toEqual([]);
    });
  });

  describe("hasSessionsForTask", () => {
    test("should return true for existing task with sessions", async () => {
      const hasSessions = await hasSessionsForTask("md#123", mockProvider);
      expect(hasSessions).toBe(true);
    });

    test("should return false for task without sessions", async () => {
      const hasSessions = await hasSessionsForTask("md#999999", mockProvider);
      expect(hasSessions).toBe(false);
    });

    test("should handle plain task ID format", async () => {
      const hasSessions = await hasSessionsForTask("123", mockProvider);
      expect(hasSessions).toBe(true);
    });
  });
});
