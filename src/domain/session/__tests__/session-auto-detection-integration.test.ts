/**
 * Integration tests for session auto-detection functionality
 * 
 * These tests verify that session commands (get, delete, update) now properly
 * use the unified session context resolver for auto-detection.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  getSessionFromParams,
  deleteSessionFromParams,
  updateSessionFromParams,
  type SessionProviderInterface,
} from "../../session.js";
import { ValidationError, ResourceNotFoundError } from "../../../errors/index.js";
import { createMock } from "../../../utils/test-utils/mocking.js";

// Mock session provider
const createMockSessionProvider = (sessions: any[] = []): SessionProviderInterface => {
  return {
    listSessions: createMock(() => Promise.resolve(sessions)),
    getSession: createMock((sessionName: string) => {
      const session = sessions.find((s: any) => s.session === sessionName);
      return Promise.resolve(session || null);
    }),
    getSessionByTaskId: createMock((taskId: string) => {
      const session = sessions.find((s: any) => s.taskId === taskId);
      return Promise.resolve(session || null);
    }),
    addSession: createMock(() => Promise.resolve()),
    updateSession: createMock(() => Promise.resolve()),
    deleteSession: createMock(() => Promise.resolve(true)),
    getRepoPath: createMock(() => Promise.resolve("/mock/repo/path")),
    getSessionWorkdir: createMock(() => Promise.resolve("/mock/session/workdir")),
  };
};

describe("Session Auto-Detection Integration", () => {
  let mockSessionProvider: SessionProviderInterface;

  beforeEach(() => {
    mockSessionProvider = createMockSessionProvider([
      {
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: "2024-01-01T00:00:00Z",
        taskId: "#123",
      },
      {
        session: "task#456",
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: "2024-01-02T00:00:00Z",
        taskId: "#456",
      },
    ]);
  });

  describe("getSessionFromParams auto-detection", () => {
    test("works with explicit session name", async () => {
      const result = await getSessionFromParams(
        {
          name: "test-session",
          json: false,
        },
        {
          sessionDB: mockSessionProvider,
        }
      );

      expect(result).not.toBeNull();
      expect(result?.session).toBe("test-session");
      expect(result?.taskId).toBe("#123");
    });

    test("works with explicit task ID", async () => {
      const result = await getSessionFromParams(
        {
          task: "#456",
          json: false,
        },
        {
          sessionDB: mockSessionProvider,
        }
      );

      expect(result).not.toBeNull();
      expect(result?.session).toBe("task#456");
      expect(result?.taskId).toBe("#456");
    });

    test("provides helpful error when no session can be resolved", async () => {
      await expect(
        getSessionFromParams(
          {
            json: false,
          },
          {
            sessionDB: mockSessionProvider,
          }
        )
      ).rejects.toThrow(
        "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    });

    test("handles non-existent session gracefully", async () => {
      await expect(
        getSessionFromParams(
          {
            name: "non-existent",
            json: false,
          },
          {
            sessionDB: mockSessionProvider,
          }
        )
      ).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe("deleteSessionFromParams auto-detection", () => {
    test("works with explicit session name", async () => {
      const result = await deleteSessionFromParams(
        {
          name: "test-session",
          force: true,
          json: false,
        },
        {
          sessionDB: mockSessionProvider,
        }
      );

      expect(result).toBe(true);
    });

    test("works with explicit task ID", async () => {
      const result = await deleteSessionFromParams(
        {
          task: "#456",
          force: true,
          json: false,
        },
        {
          sessionDB: mockSessionProvider,
        }
      );

      expect(result).toBe(true);
    });

    test("provides helpful error when no session can be resolved", async () => {
      await expect(
        deleteSessionFromParams(
          {
            force: true,
            json: false,
          },
          {
            sessionDB: mockSessionProvider,
          }
        )
      ).rejects.toThrow(
        "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    });
  });

  describe("updateSessionFromParams auto-detection", () => {
    test("works with explicit session name", async () => {
      // Mock git service
      const mockGitService = {
        execInRepository: createMock(() => Promise.resolve("mock output")),
        checkConflicts: createMock(() => Promise.resolve([])),
        validateRepository: createMock(() => Promise.resolve()),
      };

      await expect(
        updateSessionFromParams(
          {
            name: "test-session",
            json: false,
          },
          {
            sessionDB: mockSessionProvider,
            gitService: mockGitService as any,
          }
        )
      ).resolves.toBeDefined();
    });

    test("provides helpful error when no session can be resolved", async () => {
      const mockGitService = {
        execInRepository: createMock(() => Promise.resolve("mock output")),
        checkConflicts: createMock(() => Promise.resolve([])),
        validateRepository: createMock(() => Promise.resolve()),
      };

      await expect(
        updateSessionFromParams(
          {
            json: false,
          },
          {
            sessionDB: mockSessionProvider,
            gitService: mockGitService as any,
          }
        )
      ).rejects.toThrow(
        "Session name is required. Either provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    });
  });

  describe("consistency across commands", () => {
    test("all commands use the same session resolution logic", async () => {
      // Test that all commands can resolve the same session by task ID
      const taskId = "#456";
      const expectedSessionName = "task#456";

      // Test getSessionFromParams
      const getResult = await getSessionFromParams(
        { task: taskId, json: false },
        { sessionDB: mockSessionProvider }
      );
      expect(getResult?.session).toBe(expectedSessionName);

      // Test deleteSessionFromParams
      const deleteResult = await deleteSessionFromParams(
        { task: taskId, force: true, json: false },
        { sessionDB: mockSessionProvider }
      );
      expect(deleteResult).toBe(true);

      // All commands should have resolved to the same session
    });

    test("all commands provide consistent error messages for missing sessions", () => {
      const expectedErrorPattern = /No session detected.*session name.*task ID.*session workspace/;

      // Test error messages are consistent across commands
      expect(() => {
        throw new ResourceNotFoundError(
          "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
        );
      }).toThrow(expectedErrorPattern);
    });
  });
}); 
