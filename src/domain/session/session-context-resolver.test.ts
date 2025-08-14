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
} from "./session-context-resolver";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { createMockSessionProvider } from "../../utils/test-utils/index";
import type { SessionProviderInterface } from "../session";

describe("resolveSessionContext", () => {
  let mockSessionProvider: SessionProviderInterface;

  beforeEach(() => {
    mockSessionProvider = createMockSessionProvider({
      sessions: [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123", // Strict qualified format
        },
        {
          session: "task#456",
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: "2024-01-02T00:00:00Z",
          taskId: "md#456", // Strict qualified format
        },
      ],
    });
  });

  describe("explicit session resolution", () => {
    test("resolves existing session by name", async () => {
      const result = await resolveSessionContext({
        session: "test-session",
        sessionProvider: mockSessionProvider,
        allowAutoDetection: false,
      });

      expect(result.sessionName).toBe("test-session");
      expect(result.taskId).toBe("md#123");
      expect(result.resolvedBy).toBe("explicit-session");
      expect(result.workingDirectory).toBeTruthy();
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
        task: "md#456",
        sessionProvider: mockSessionProvider,
        allowAutoDetection: false,
      });

      expect(result.sessionName).toBe("task#456");
      expect(result.taskId).toBe("md#456");
      expect(result.resolvedBy).toBe("explicit-task");
      expect(result.workingDirectory).toBeTruthy();
    });

    test("throws error for non-existent task", async () => {
      await expect(
        resolveSessionContext({
          task: "md#999",
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
        task: "456",
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
    const mockSessionProvider = createMockSessionProvider({
      sessions: [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        },
      ],
    });

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
    const mockSessionProvider = createMockSessionProvider({
      sessions: [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "123",
        },
      ],
    });

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
