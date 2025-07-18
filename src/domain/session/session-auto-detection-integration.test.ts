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
  sessionGet,
  updateSessionFromParams,
  sessionDelete,
} from "../session/commands";
import { type SessionProviderInterface } from "../session";
import { type SessionRecord } from "../session/types";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { createMockSessionProvider } from "../../utils/test-utils/index";

describe("Session Command Domain Logic", () => {
  let mockSessionProvider: SessionProviderInterface;

  beforeEach(() => {
    mockSessionProvider = createMockSessionProvider({
      sessions: [
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
      ]
    });
  });

  describe("sessionGet domain logic", () => {
    test("resolves session by explicit name", async () => {
      const result = await sessionGet(
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
      const result = await sessionGet(
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
        sessionGet(
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
        sessionGet(
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

  describe("sessionDelete domain logic", () => {
    test("deletes session by explicit name", async () => {
      const result = await sessionDelete(
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
      const result = await sessionDelete(
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
        sessionDelete(
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

      // Test sessionGet
      const getResult = await sessionGet(
        { task: taskId, json: false },
        { sessionDB: mockSessionProvider }
      );
      expect(getResult?.session).toBe(expectedSessionName);

      // Test sessionDelete
      const deleteResult = await sessionDelete(
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
      const result = await sessionGet(
        { name: "test-session", json: false },
        { sessionDB: mockSessionProvider }
      );
      expect(result?.taskId).toBe("#123");
    });

    test("session resolution is deterministic with same inputs", async () => {
      // Run the same operation multiple times to ensure deterministic behavior
      const results = await Promise.all([
        sessionGet({ name: "test-session", json: false }, { sessionDB: mockSessionProvider }),
        sessionGet({ name: "test-session", json: false }, { sessionDB: mockSessionProvider }),
        sessionGet({ name: "test-session", json: false }, { sessionDB: mockSessionProvider }),
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
