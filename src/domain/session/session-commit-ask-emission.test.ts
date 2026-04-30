/**
 * Tests for the authorization.approve Ask emission in sessionCommit.
 *
 * Acceptance tests from mt#1466:
 *   1. sessionCommit emits exactly one Ask before the commit attempt, with correct fields.
 *   2. When AskRepository.create() throws, sessionCommit still proceeds (best-effort emission).
 *
 * Strategy: Because sessionCommit uses dynamic imports for git operations that
 * require a real repository, we drive the function up to the git call and let
 * it fail there. The Ask emission happens BEFORE the git call, so we can assert
 * on FakeAskRepository state even when the overall promise rejects.
 */

import { describe, test, expect } from "bun:test";
import { sessionCommit } from "./session-commands";
import { FakeAskRepository } from "../ask/repository";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "test-session-uuid",
    repoName: "test-repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "1466",
    agentId: "com.anthropic.claude-code:proc:test-agent-id",
    ...overrides,
  };
}

/**
 * FakeSessionProvider override that does NOT have a merged PR
 * (so assertSessionMutable does not block the Ask emission).
 */
function makeSessionProvider(record: SessionRecord): FakeSessionProvider {
  const provider = new FakeSessionProvider({
    initialSessions: [record],
    sessionWorkdir: "/nonexistent/workdir",
  });
  return provider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sessionCommit Ask emission", () => {
  test("emits exactly one authorization.approve Ask before commit attempt", async () => {
    const record = makeSessionRecord();
    const sessionProvider = makeSessionProvider(record);
    const askRepo = new FakeAskRepository();

    // sessionCommit will fail when it reaches the git operations (nonexistent workdir),
    // but the Ask emission happens before that. We catch the error and check the repo.
    await expect(
      sessionCommit(
        { session: "test-session-uuid", message: "feat: test commit message" },
        sessionProvider,
        askRepo
      )
    ).rejects.toThrow(); // git commit fails — expected in test environment

    const asks = askRepo.all;
    expect(asks).toHaveLength(1);

    const ask = asks[0];
    if (!ask) throw new Error("Expected one Ask to be emitted");
    expect(ask.kind).toBe("authorization.approve");
    expect(ask.state).toBe("detected");
    expect(ask.classifierVersion).toBe("v1");
    expect(ask.requestor).toBe("com.anthropic.claude-code:proc:test-agent-id");
    expect(ask.parentTaskId).toBe("1466");
    expect(ask.parentSessionId).toBe("test-session-uuid");
    expect(ask.metadata.commitMessage).toBe("feat: test commit message");
  });

  test("Ask carries parentTaskId and parentSessionId from session record", async () => {
    const record = makeSessionRecord({
      sessionId: "session-abc-123",
      taskId: "mt#999",
      agentId: "minsky.native-subagent:task:mt#999@com.anthropic.claude-code:proc:parent",
    });
    const sessionProvider = makeSessionProvider(record);
    const askRepo = new FakeAskRepository();

    await expect(
      sessionCommit(
        { session: "session-abc-123", message: "fix: another commit" },
        sessionProvider,
        askRepo
      )
    ).rejects.toThrow();

    const ask = askRepo.all[0];
    if (!ask) throw new Error("Expected one Ask to be emitted");
    expect(ask.parentTaskId).toBe("mt#999");
    expect(ask.parentSessionId).toBe("session-abc-123");
    expect(ask.requestor).toBe(
      "minsky.native-subagent:task:mt#999@com.anthropic.claude-code:proc:parent"
    );
  });

  test("falls back to session-derived requestor when agentId is absent", async () => {
    const record = makeSessionRecord({ agentId: undefined });
    const sessionProvider = makeSessionProvider(record);
    const askRepo = new FakeAskRepository();

    await expect(
      sessionCommit(
        { session: "test-session-uuid", message: "chore: no agent id" },
        sessionProvider,
        askRepo
      )
    ).rejects.toThrow();

    const ask = askRepo.all[0];
    if (!ask) throw new Error("Expected one Ask to be emitted");
    // Falls back to derived requestor — must not be empty
    expect(ask.requestor).toMatch(/test-session-uuid/);
  });

  test("does NOT emit Ask when no askRepository is provided", async () => {
    const record = makeSessionRecord();
    const sessionProvider = makeSessionProvider(record);

    // No askRepo passed — commit should still be attempted (and fail in test env)
    await expect(
      sessionCommit({ session: "test-session-uuid", message: "feat: no ask repo" }, sessionProvider)
    ).rejects.toThrow();

    // Nothing to assert on (no repo provided) — this just confirms no crash from missing repo
  });

  test("commit proceeds even when AskRepository.create throws (best-effort emission)", async () => {
    const record = makeSessionRecord();
    const sessionProvider = makeSessionProvider(record);

    // Broken AskRepository — create always throws
    const brokenAskRepo: FakeAskRepository = new FakeAskRepository();
    (brokenAskRepo as unknown as { create: () => never }).create = () => {
      throw new Error("DB unavailable");
    };

    // The overall call should still proceed past the Ask emission and reach the git step
    // (which will also fail, since the workdir doesn't exist).
    // Key assertion: the error thrown is the git error, NOT the Ask error.
    const err = await sessionCommit(
      { session: "test-session-uuid", message: "feat: broken ask repo" },
      sessionProvider,
      brokenAskRepo as unknown as FakeAskRepository
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    // The error should NOT mention "DB unavailable" — that was swallowed by the best-effort catch
    expect((err as Error).message).not.toContain("DB unavailable");
  });
});
