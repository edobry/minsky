/**
 * Tests for the unified session context resolver
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveSessionContext,
  resolveSessionId,
  validateSessionContext,
} from "./session-context-resolver";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionProviderInterface } from "../session";

describe("resolveSessionContext", () => {
  let mockSessionProvider: SessionProviderInterface;

  beforeEach(() => {
    mockSessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "test-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123", // Qualified format for storage
        },
        {
          sessionId: "task#456",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-02T00:00:00Z",
          taskId: "md#456", // Qualified format for storage
        },
      ],
    });
  });

  describe("explicit session resolution", () => {
    test("resolves existing session by name", async () => {
      const result = await resolveSessionContext({
        sessionId: "test-session",
        sessionProvider: mockSessionProvider,
        allowAutoDetection: false,
      });

      expect(result.sessionId).toBe("test-session");
      expect(result.taskId).toBe("md#123");
      expect(result.resolvedBy).toBe("explicit-session");
      expect(result.workingDirectory).toBeDefined(); // Don't hard-code environment-dependent path
    });

    test("throws error for non-existent session", async () => {
      await expect(
        resolveSessionContext({
          sessionId: "non-existent",
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

      expect(result.sessionId).toBe("task#456");
      expect(result.taskId).toBe("md#456");
      expect(result.resolvedBy).toBe("explicit-task");
      expect(result.workingDirectory).toBeDefined(); // Don't hard-code environment-dependent path
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
        sessionId: "test-session",
        task: "md#456",
        sessionProvider: mockSessionProvider,
        allowAutoDetection: false,
      });

      expect(result.sessionId).toBe("test-session");
      expect(result.resolvedBy).toBe("explicit-session");
    });
  });
});

describe("resolveSessionId", () => {
  test("returns just the session ID", async () => {
    const mockSessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "test-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123",
        },
      ],
    });

    const sessionId = await resolveSessionId({
      sessionId: "test-session",
      sessionProvider: mockSessionProvider,
      allowAutoDetection: false,
    });

    expect(sessionId).toBe("test-session");
  });
});

describe("validateSessionContext", () => {
  test("returns true for valid session", async () => {
    const mockSessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "test-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "md#123",
        },
      ],
    });

    const isValid = await validateSessionContext({
      sessionId: "test-session",
      sessionProvider: mockSessionProvider,
      allowAutoDetection: false,
    });

    expect(isValid).toBe(true);
  });

  test("returns false for invalid session", async () => {
    const mockSessionProvider = new FakeSessionProvider();

    const isValid = await validateSessionContext({
      sessionId: "non-existent",
      sessionProvider: mockSessionProvider,
      allowAutoDetection: false,
    });

    expect(isValid).toBe(false);
  });
});
