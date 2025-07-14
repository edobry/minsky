/**
 * Tests for the unified session context resolver
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveSessionContext,
  resolveSessionName,
  resolveSessionContextWithFeedback,
  validateSessionContext,
  type SessionContextOptions,
  type ResolvedSessionContext,
} from "../session-context-resolver.js";
import { ValidationError, ResourceNotFoundError } from "../../../errors/index.js";
import { createMock } from "../../../utils/test-utils/mocking.js";
import type { SessionProviderInterface } from "../session.js";

// Mock session provider with basic functionality
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

describe("resolveSessionContext", () => {
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

  describe("explicit session resolution", () => {
    test("resolves existing session by name", async () => {
      const result = await resolveSessionContext({
        session: "test-session",
        sessionProvider: mockSessionProvider,
        allowAutoDetection: false,
      });

      expect(result).toEqual({
        sessionName: "test-session",
        taskId: "#123",
        resolvedBy: "explicit-session",
        workingDirectory: process.cwd(),
      });
    });

    test("throws error for non-existent session", async () => {
      await expect(
        resolveSessionContext({
          session: "non-existent",
          sessionProvider: mockSessionProvider,
          allowAutoDetection: false,
        })
      ).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe("task ID resolution", () => {
    test("resolves session by task ID", async () => {
      const result = await resolveSessionContext({
        task: "#456",
        sessionProvider: mockSessionProvider,
        allowAutoDetection: false,
      });

      expect(result).toEqual({
        sessionName: "task#456",
        taskId: "#456",
        resolvedBy: "explicit-task",
        workingDirectory: process.cwd(),
      });
    });

    test("throws error for non-existent task", async () => {
      await expect(
        resolveSessionContext({
          task: "#999",
          sessionProvider: mockSessionProvider,
          allowAutoDetection: false,
        })
      ).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe("no session provided", () => {
    test("throws error when no session detected and auto-detection disabled", async () => {
      await expect(
        resolveSessionContext({
          sessionProvider: mockSessionProvider,
          allowAutoDetection: false,
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("precedence", () => {
    test("explicit session takes precedence over task", async () => {
      const result = await resolveSessionContext({
        session: "test-session",
        task: "#456",
        sessionProvider: mockSessionProvider,
        allowAutoDetection: false,
      });

      expect(result.sessionName).toBe("test-session");
      expect(result.resolvedBy).toBe("explicit-session");
    });
  });
});

describe("resolveSessionName", () => {
  test("returns just the session name", async () => {
    const mockSessionProvider = createMockSessionProvider([
      {
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: "2024-01-01T00:00:00Z",
        taskId: "#123",
      },
    ]);

    const sessionName = await resolveSessionName({
      session: "test-session",
      sessionProvider: mockSessionProvider,
      allowAutoDetection: false,
    });

    expect(sessionName).toBe("test-session");
  });
});

describe("validateSessionContext", () => {
  test("returns true for valid session", async () => {
    const mockSessionProvider = createMockSessionProvider([
      {
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: "2024-01-01T00:00:00Z",
        taskId: "#123",
      },
    ]);

    const isValid = await validateSessionContext({
      session: "test-session",
      sessionProvider: mockSessionProvider,
      allowAutoDetection: false,
    });

    expect(isValid).toBe(true);
  });

  test("returns false for invalid session", async () => {
    const mockSessionProvider = createMockSessionProvider();

    const isValid = await validateSessionContext({
      session: "non-existent",
      sessionProvider: mockSessionProvider,
      allowAutoDetection: false,
    });

    expect(isValid).toBe(false);
  });
}); 
