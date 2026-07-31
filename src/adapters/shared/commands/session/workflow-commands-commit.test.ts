/**
 * Tests for session_commit's `task` convenience-resolution param (mt#2816).
 *
 * mt#2816 closed a param-alias drift: `session_commit` accepted `sessionId`
 * but silently rejected `task`, even though `session_start`/`session_exec`
 * both accept `task` as an alias that resolves to the session bound to that
 * task. This suite exercises the WIRING inside `createSessionCommitCommand`
 * (not just the underlying `resolveSessionIdForCommand` resolver, which has
 * its own unit tests in `session-context-resolver.test.ts`) — proving the
 * command's execute() actually calls the resolver with the right params and
 * that a resolution failure (ambiguity / no session found) propagates before
 * ever reaching the git-commit domain call.
 *
 * These tests are scoped to the resolution-FAILURE paths, which throw before
 * `sessionCommit()` (the domain function that shells out to git) is ever
 * invoked — so no git/filesystem fixtures are needed. The resolver's
 * "single active session for a task -> resolve" success path is covered
 * directly in session-context-resolver.test.ts; this suite proves the
 * command wires that resolver in, not the resolver's own internals.
 */

import { describe, test, expect } from "bun:test";
import { createSessionCommitCommand } from "./workflow-commands";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import { ResourceNotFoundError, ValidationError } from "@minsky/domain/errors/index";
import type { SessionCommandDependencies } from "./types";

function buildGetDeps(sessionDB: FakeSessionProvider): () => Promise<SessionCommandDependencies> {
  return async () =>
    ({
      sessionProvider: sessionDB,
    }) as unknown as SessionCommandDependencies;
}

describe("session_commit task-resolution alias (mt#2816)", () => {
  test("no session for task: propagates ResourceNotFoundError before attempting a commit", async () => {
    const sessionDB = new FakeSessionProvider();
    const command = createSessionCommitCommand(buildGetDeps(sessionDB));

    await expect(
      command.execute(
        {
          task: "mt#9999",
          message: "test commit",
        },
        {}
      )
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test("ambiguity: propagates a structured error naming every candidate session", async () => {
    const sessionDB = new FakeSessionProvider({
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
    const command = createSessionCommitCommand(buildGetDeps(sessionDB));

    let caught: unknown;
    try {
      await command.execute(
        {
          task: "mt#2816",
          message: "test commit",
        },
        {}
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const message = (caught as ValidationError).message;
    expect(message).toContain("session-alpha");
    expect(message).toContain("session-beta");
  });

  test("neither sessionId nor task: falls through to sessionCommit's own required-param check", async () => {
    const sessionDB = new FakeSessionProvider();
    const command = createSessionCommitCommand(buildGetDeps(sessionDB));

    // Regression: unchanged pre-existing behavior when the caller supplies
    // neither resolution param — resolveSessionIdForCommand returns
    // `undefined`, and sessionCommit()'s own "Session parameter is required"
    // MinskyError(VALIDATION_ERROR) check fires exactly as it did before
    // `task` was added to the params map.
    await expect(
      command.execute(
        {
          message: "test commit",
        },
        {}
      )
    ).rejects.toThrow("Session parameter is required");
  });
});
