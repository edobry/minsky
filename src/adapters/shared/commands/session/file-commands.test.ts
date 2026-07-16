/**
 * Regression test for the session_edit-file sessionId-resolution fix (mt#2742).
 *
 * The bug (Detector B): `resolveSessionId` read `params.session`, but the command
 * declares `sessionId` (session-parameters.ts) — so an explicitly-passed session id
 * arrived under `sessionId`, `params.session` was always undefined, and the command
 * silently fell through to `getCurrentSession(cwd)` auto-detection, ignoring the id.
 * The fix resolves `params.sessionId` (mt#2779 retired the undeclared `session`
 * fallback entirely — the mt#2778 MCP boundary rejects undeclared keys, so it can
 * never arrive; the resolver now ignores it).
 *
 * These assert the resolver via injected deps (no filesystem/session I/O), mirroring
 * apply-post-merge-state-sync-command.test.ts's resolver-test pattern.
 */

import { describe, test, expect } from "bun:test";
import { resolveSessionId, type SessionEditFileParams } from "./file-commands";
import { MinskyError, ResourceNotFoundError, ValidationError } from "@minsky/domain/errors/index";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import type { SessionCommandDependencies } from "./types";

function depsWithCurrent(
  current: string | null,
  calls?: string[],
  sessionProvider?: FakeSessionProvider
): SessionCommandDependencies {
  return {
    getCurrentSession: async (cwd: string) => {
      calls?.push(cwd);
      return current;
    },
    sessionProvider: sessionProvider ?? new FakeSessionProvider(),
  } as unknown as SessionCommandDependencies;
}

describe("resolveSessionId (session_edit-file, mt#2742)", () => {
  test("honors the canonical sessionId param and does NOT auto-detect", async () => {
    const calls: string[] = [];
    const id = await resolveSessionId(depsWithCurrent("auto-detected", calls), {
      sessionId: "explicit-1",
    } as SessionEditFileParams);
    expect(id).toBe("explicit-1");
    // The bug: this used to be ignored → getCurrentSession consulted anyway.
    expect(calls).toEqual([]);
  });

  test("ignores the retired undeclared `session` key and auto-detects instead (mt#2779)", async () => {
    const id = await resolveSessionId(
      depsWithCurrent("auto-detected"),
      // Simulates a rogue direct caller passing the retired key — the declared
      // surface has no `session`, so the resolver must not honor it.
      { session: "legacy-1" } as unknown as SessionEditFileParams
    );
    expect(id).toBe("auto-detected");
  });

  test("auto-detects from cwd only when no sessionId is provided", async () => {
    const calls: string[] = [];
    const id = await resolveSessionId(
      depsWithCurrent("current-session", calls),
      {} as SessionEditFileParams
    );
    expect(id).toBe("current-session");
    expect(calls).toHaveLength(1);
  });

  test("throws when no sessionId is provided and no current session is detectable", async () => {
    await expect(
      resolveSessionId(depsWithCurrent(null), {} as SessionEditFileParams)
    ).rejects.toBeInstanceOf(MinskyError);
  });
});

const TASK_RESOLUTION_SESSION_ID = "session-for-task";

/**
 * mt#2816: session_* param-alias parity — session.edit-file gained the same
 * `task` convenience-resolution alias session_start/session_exec already had.
 */
describe("resolveSessionId task-resolution alias (mt#2816)", () => {
  test("resolves the session bound to `task` when no explicit sessionId is given", async () => {
    const sessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: TASK_RESOLUTION_SESSION_ID,
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "mt#2816",
        },
      ],
    });
    const calls: string[] = [];

    const id = await resolveSessionId(depsWithCurrent("auto-detected", calls, sessionProvider), {
      task: "mt#2816",
    } as SessionEditFileParams);

    expect(id).toBe(TASK_RESOLUTION_SESSION_ID);
    // task resolution took precedence over cwd auto-detection.
    expect(calls).toEqual([]);
  });

  test("explicit sessionId still wins over task", async () => {
    const sessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: TASK_RESOLUTION_SESSION_ID,
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          createdAt: "2024-01-01T00:00:00Z",
          taskId: "mt#2816",
        },
      ],
    });

    const id = await resolveSessionId(
      depsWithCurrent("auto-detected", undefined, sessionProvider),
      {
        sessionId: "explicit-1",
        task: "mt#2816",
      } as SessionEditFileParams
    );

    expect(id).toBe("explicit-1");
  });

  test("ambiguity: propagates a structured error naming every candidate session", async () => {
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

    await expect(
      resolveSessionId(depsWithCurrent("auto-detected", undefined, sessionProvider), {
        task: "mt#2816",
      } as SessionEditFileParams)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("no session for task: propagates ResourceNotFoundError instead of silently auto-detecting", async () => {
    const sessionProvider = new FakeSessionProvider();

    await expect(
      resolveSessionId(depsWithCurrent("auto-detected", undefined, sessionProvider), {
        task: "mt#9999",
      } as SessionEditFileParams)
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
