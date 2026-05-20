/**
 * Tests for sessionPrClose (mt#1955).
 *
 * Hermetic unit tests covering validation paths and the prNumber addressing
 * surface added in PR #1184 review R1.
 *
 * The GitHub state-flip and already-closed/merged refusal paths live in
 * `closePullRequest` itself (called via `pr.close()`) and require a real
 * Octokit; covered indirectly via the `createRepositoryBackendFromSession`
 * indirection and deferred to live verification.
 */

import { describe, test, expect, mock } from "bun:test";
import { sessionPrClose } from "./pr-close-subcommand";
import { ResourceNotFoundError, ValidationError } from "../../../errors/index";
import type { SessionProviderInterface } from "../types";

function makeSessionDB(sessionRecord: unknown): SessionProviderInterface {
  return {
    getSession: mock(() => Promise.resolve(sessionRecord)),
    listSessions: mock(() => Promise.resolve([])),
    addSession: mock(() => Promise.resolve()),
    deleteSession: mock(() => Promise.resolve(true)),
    updateSession: mock(() => Promise.resolve()),
    getRepoPath: mock(() => Promise.resolve("/fake/path")),
    getSessionByTaskId: mock(() => Promise.resolve(null)),
    getSessionWorkdir: mock(() => Promise.resolve("/fake/workdir")),
  } as unknown as SessionProviderInterface;
}

describe("sessionPrClose — validation", () => {
  test("rejects call with no identifier (no task, sessionId, or prNumber) with ValidationError", async () => {
    const sessionDB = makeSessionDB(null);
    await expect(sessionPrClose({}, { sessionDB })).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects an unresolvable session with ResourceNotFoundError", async () => {
    const sessionDB = makeSessionDB(null);
    // resolveSessionContextWithFeedback throws ResourceNotFoundError when
    // sessionId is provided but the session is not found.
    await expect(
      sessionPrClose({ sessionId: "nonexistent" }, { sessionDB })
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test("rejects a session that is not GitHub-backed with ValidationError", async () => {
    const sessionDB = makeSessionDB({
      session: "s1",
      sessionId: "s1",
      taskId: "mt#1",
      repoUrl: "https://example.com/repo",
      backendType: "local",
      pullRequest: { number: 42 },
    });
    await expect(sessionPrClose({ sessionId: "s1" }, { sessionDB })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  test("rejects a GitHub session with no recorded PR (and no prNumber override) with ValidationError", async () => {
    const sessionDB = makeSessionDB({
      session: "s1",
      sessionId: "s1",
      taskId: "mt#1",
      repoUrl: "https://github.com/owner/repo",
      backendType: "github",
      // no pullRequest field
    });
    await expect(sessionPrClose({ sessionId: "s1" }, { sessionDB })).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});
