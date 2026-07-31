/**
 * Tests for the unified session context resolver
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveSessionContext,
  resolveSessionId,
  resolveSessionIdForCommand,
  validateSessionContext,
} from "./session-context-resolver";
import { ValidationError, ResourceNotFoundError } from "../errors/index";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionProviderInterface } from "../session";
import { makeDeferredFailurePlaceholder } from "../composition/container";

/** Shared fixture uuid for the mt#2967 canonical-id-propagation tests below. */
const CANONICAL_TEST_UUID = "6f9a3b10-1111-4a22-8888-abcdefabcdef";

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

  describe("canonical-id propagation (mt#2967)", () => {
    test("returns the sessionProvider record's canonical sessionId, not the raw input", async () => {
      // Simulates a ws#N short id / hex-prefix input: the sessionProvider
      // (DrizzleSessionRepository in production) resolves it internally and
      // returns a record whose .sessionId is the CANONICAL uuid, which
      // differs from the raw input string the caller supplied.
      const shortIdAwareProvider = {
        getSession: async (input: string) =>
          input === "ws#7"
            ? {
                sessionId: CANONICAL_TEST_UUID,
                repoName: "test-repo",
                repoUrl: "https://github.com/test/repo.git",
                createdAt: "2024-01-01T00:00:00Z",
                taskId: "md#123",
              }
            : null,
      } as unknown as SessionProviderInterface;

      const result = await resolveSessionContext({
        sessionId: "ws#7",
        sessionProvider: shortIdAwareProvider,
        allowAutoDetection: false,
      });

      expect(result.sessionId).toBe(CANONICAL_TEST_UUID);
      expect(result.taskId).toBe("md#123");
    });

    test("falls back to the raw input when the returned record has no sessionId (defensive)", async () => {
      // Defends against malformed/test-double records missing `.sessionId`
      // (several pre-existing fixtures across the codebase use a legacy
      // `session:` field instead) — every real persisted row always has one.
      const malformedRecordProvider = {
        getSession: async () => ({ session: "s", taskId: "md#1" }) as never,
      } as unknown as SessionProviderInterface;

      const result = await resolveSessionContext({
        sessionId: "s",
        sessionProvider: malformedRecordProvider,
        allowAutoDetection: false,
      });

      expect(result.sessionId).toBe("s");
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

  // mt#2945: reproduces the post-reload failure mode where `sessionProvider`
  // resolves to the DI container's deferred-failure placeholder (because
  // persistence was unavailable when the provider was constructed) instead
  // of a real SessionProviderInterface. Before the fix, the diagnostic
  // `log.debug` call's `sessionProvider.constructor.name` read crashed with a
  // raw "undefined is not an object" TypeError — this exercises that exact
  // code path and asserts it now either resolves cleanly or fails with the
  // deferred placeholder's clear, actionable "service unavailable" message,
  // never the opaque null-deref.
  describe("reload path — unwired sessionProvider (mt#2945)", () => {
    test("a deferred-failure placeholder sessionProvider fails with a clear message, not a null-deref", async () => {
      const placeholderSessionProvider = makeDeferredFailurePlaceholder(
        "sessionProvider",
        "Persistence is not configured: no Postgres connection configured"
      ) as unknown as SessionProviderInterface;

      await expect(
        resolveSessionContext({
          sessionId: "test-session",
          sessionProvider: placeholderSessionProvider,
          allowAutoDetection: false,
        })
      ).rejects.toThrow(/Service "sessionProvider" is unavailable/);
    });

    test("a genuinely undefined sessionProvider does not crash with a raw null-deref", async () => {
      // Defensive case: even if a caller passes `undefined` directly (not
      // routed through the DI container's placeholder), the diagnostic log
      // line must not itself throw. The subsequent `sessionProvider.getSession`
      // call surfaces its own (TypeError) failure, but NOT the opaque
      // "evaluating 'sessionProvider.constructor.name'" crash.
      const undefinedSessionProvider = undefined as unknown as SessionProviderInterface;

      let caught: unknown;
      try {
        await resolveSessionContext({
          sessionId: "test-session",
          sessionProvider: undefinedSessionProvider,
          allowAutoDetection: false,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).not.toContain("sessionProvider.constructor.name");
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

/**
 * mt#2816: session_* param-alias parity. This resolver backs the `task`
 * convenience-resolution param session_commit and session.edit-file gained
 * (matching session_start/session_exec semantics), and adds ambiguity
 * detection those legacy `getSessionByTaskId`-based lookups never had.
 */
describe("resolveSessionIdForCommand", () => {
  const EXPLICIT_SESSION_ID = "explicit-session-id";

  test("explicit sessionId is returned as-is, no lookup performed", async () => {
    // No sessions registered at all — if this resolver tried to validate
    // existence or look anything up, it would fail. Regression: unchanged
    // behavior for existing sessionId-based callers.
    const sessionProvider = new FakeSessionProvider();

    const resolved = await resolveSessionIdForCommand({
      sessionId: EXPLICIT_SESSION_ID,
      sessionProvider,
    });

    expect(resolved).toBe(EXPLICIT_SESSION_ID);
  });

  test("sessionId wins over task when both are supplied", async () => {
    const sessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "session-for-task",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "mt#2816",
        },
      ],
    });

    const resolved = await resolveSessionIdForCommand({
      sessionId: EXPLICIT_SESSION_ID,
      task: "mt#2816",
      sessionProvider,
    });

    expect(resolved).toBe(EXPLICIT_SESSION_ID);
  });

  test("resolves task to its single active session", async () => {
    const sessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "the-one-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "mt#2739",
        },
      ],
    });

    const resolved = await resolveSessionIdForCommand({
      task: "mt#2739",
      sessionProvider,
    });

    expect(resolved).toBe("the-one-session");
  });

  test("throws ResourceNotFoundError when no session exists for the task", async () => {
    const sessionProvider = new FakeSessionProvider();

    await expect(
      resolveSessionIdForCommand({
        task: "mt#9999",
        sessionProvider,
      })
    ).rejects.toThrow(ResourceNotFoundError);
  });

  test("ambiguity: throws a structured error naming every candidate session", async () => {
    const sessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: "session-alpha",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "mt#2816",
        },
        {
          sessionId: "session-beta",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-02T00:00:00Z",
          taskId: "mt#2816",
        },
      ],
    });

    let caught: unknown;
    try {
      await resolveSessionIdForCommand({ task: "mt#2816", sessionProvider });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const err = caught as ValidationError;
    // Naming both candidates in the message (human-readable) ...
    expect(err.message).toContain("session-alpha");
    expect(err.message).toContain("session-beta");
    // ... and as structured data (machine-readable).
    const errors = err.errors as { candidateSessionIds?: string[] } | undefined;
    expect(errors?.candidateSessionIds).toEqual(["session-alpha", "session-beta"]);
  });

  test("returns undefined when neither sessionId nor task is provided", async () => {
    const sessionProvider = new FakeSessionProvider();

    const resolved = await resolveSessionIdForCommand({ sessionProvider });

    expect(resolved).toBeUndefined();
  });

  describe("canonical-id resolution (mt#2967)", () => {
    test("resolves a ws#N short id / hex-prefix input to the canonical sessionId via getSession", async () => {
      // Simulates the DrizzleSessionRepository production wiring: getSession
      // resolves a ws#N/hex-prefix input internally and returns the record
      // under its CANONICAL uuid — resolveSessionIdForCommand must surface
      // that canonical id, not echo the raw short-id token back.
      const shortIdAwareProvider = {
        getSession: async (input: string) =>
          input === "ws#7"
            ? {
                sessionId: CANONICAL_TEST_UUID,
                repoName: "test-repo",
                repoUrl: "https://github.com/test/repo.git",
                createdAt: "2024-01-01T00:00:00Z",
              }
            : null,
      } as unknown as SessionProviderInterface;

      const resolved = await resolveSessionIdForCommand({
        sessionId: "ws#7",
        sessionProvider: shortIdAwareProvider,
      });

      expect(resolved).toBe(CANONICAL_TEST_UUID);
    });

    test("falls back to the raw input when getSession finds no matching row (existence validation left to caller)", async () => {
      const sessionProvider = new FakeSessionProvider(); // no sessions registered

      const resolved = await resolveSessionIdForCommand({
        sessionId: "ws#999",
        sessionProvider,
      });

      expect(resolved).toBe("ws#999");
    });
  });
});
