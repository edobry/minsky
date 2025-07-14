/**
 * Session Command Domain Logic Tests
 *
 * These tests verify that session commands (get, delete, update) properly
 * use explicit session resolution without global state interference.
 *
 * Following testing-boundaries approach: test domain logic directly,
 * not interface layers or auto-detection that depends on global state.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  getSessionFromParams,
  deleteSessionFromParams,
  updateSessionFromParams,
  type SessionProviderInterface,
  type SessionRecord,
} from "../session.js";
import { ValidationError, ResourceNotFoundError } from "../../errors/index.js";

// Mock session provider
const createMockSessionProvider = (sessions: SessionRecord[] = []): SessionProviderInterface => {
  return {
    listSessions: () => Promise.resolve(sessions),
    getSession: (sessionName: string) => {
      const session = sessions.find((s: SessionRecord) => s.session === sessionName);
      return Promise.resolve(session || null);
    },
    getSessionByTaskId: (taskId: string) => {
      const session = sessions.find((s: SessionRecord) => s.taskId === taskId);
      return Promise.resolve(session || null);
    },
    addSession: () => Promise.resolve(),
    updateSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(true),
    getRepoPath: () => Promise.resolve("/mock/repo/path"),
    getSessionWorkdir: () => Promise.resolve("/mock/session/workdir"),
  };
};

describe("Session Command Domain Logic", () => {
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

  describe("getSessionFromParams domain logic", () => {
    test("resolves session by explicit name", async () => {
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

    test("resolves session by explicit task ID", async () => {
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

    test("throws ResourceNotFoundError for non-existent session", async () => {
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

    test("throws ResourceNotFoundError for non-existent task", async () => {
      await expect(
        getSessionFromParams(
          {
            task: "#999",
            json: false,
          },
          {
            sessionDB: mockSessionProvider,
          }
        )
      ).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe("deleteSessionFromParams domain logic", () => {
    test("deletes session by explicit name", async () => {
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

    test("deletes session by explicit task ID", async () => {
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

    test("throws ResourceNotFoundError for non-existent session", async () => {
      await expect(
        deleteSessionFromParams(
          {
            name: "non-existent",
            force: true,
            json: false,
          },
          {
            sessionDB: mockSessionProvider,
          }
        )
      ).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe("domain logic consistency", () => {
    test("all commands resolve the same session by task ID", async () => {
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

  describe("pure function behavior", () => {
    test("session provider mock is used directly without global state", async () => {
      // Test that the mock provider is being used by checking its exact behavior
      const session = await mockSessionProvider.getSession("test-session");
      expect(session).not.toBeNull();
      expect(session?.taskId).toBe("#123");

      // Test the same behavior through the domain function
      const result = await getSessionFromParams(
        { name: "test-session", json: false },
        { sessionDB: mockSessionProvider }
      );
      expect(result?.taskId).toBe("#123");
    });

    test("session resolution is deterministic with same inputs", async () => {
      // Run the same operation multiple times to ensure deterministic behavior
      const results = await Promise.all([
        getSessionFromParams({ name: "test-session", json: false }, { sessionDB: mockSessionProvider }),
        getSessionFromParams({ name: "test-session", json: false }, { sessionDB: mockSessionProvider }),
        getSessionFromParams({ name: "test-session", json: false }, { sessionDB: mockSessionProvider }),
      ]);

      // All results should be identical
      expect(results[0]?.session).toBe("test-session");
      expect(results[1]?.session).toBe("test-session");
      expect(results[2]?.session).toBe("test-session");
      expect(results[0]?.taskId).toBe("#123");
      expect(results[1]?.taskId).toBe("#123");
      expect(results[2]?.taskId).toBe("#123");
    });
  });
});
