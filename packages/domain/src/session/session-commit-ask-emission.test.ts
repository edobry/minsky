/**
 * Tests for the authorization.approve Ask emission in sessionCommit.
 *
 * Acceptance tests from mt#1466:
 *   1. sessionCommit emits exactly one Ask before the commit attempt, with correct fields.
 *   2. When AskRepository.create() throws, sessionCommit still proceeds (best-effort emission).
 *   3. A clean working tree (NothingToCommitError case) results in zero Asks emitted.
 *
 * Strategy: Because sessionCommit uses dynamic imports for git operations that
 * require a real repository, we drive the function up to the git call and let
 * it fail there. The Ask emission happens BEFORE the git call, so we can assert
 * on FakeAskRepository state even when the overall promise rejects.
 *
 * For the nothing-to-commit test, we use a real temp git repo (initialized with
 * an empty commit so it is in clean state) as the session workdir.
 */

import { describe, test, expect, afterAll } from "bun:test";
// Real FS imports below are required by the nothing-to-commit test, which needs a genuine git
// repository so that hasUncommittedChanges (shelling out to git) can return false. There is no
// in-memory substitute; DI injection would defeat testing the actual detection path end-to-end.
/* eslint-disable custom/no-real-fs-in-tests */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "path";
import { execSync } from "child_process";
import { sessionCommit } from "./session-commands";
import { FakeAskRepository } from "../ask/repository";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";
import type { PersistenceProvider } from "../persistence/types";

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
function makeSessionProvider(record: SessionRecord, workdir?: string): FakeSessionProvider {
  const provider = new FakeSessionProvider({
    initialSessions: [record],
    sessionWorkdir: workdir ?? "/nonexistent/workdir",
  });
  return provider;
}

/**
 * Create a temporary git repository with one initial commit so the
 * working tree is in a clean state. Returns the path to the repo.
 */
async function makeTmpCleanGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-ask-test-"));
  // Init, configure, and make an empty initial commit so HEAD is valid.
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

/**
 * Create a temporary git repository with an UNTRACKED file so the working
 * tree is dirty (hasUncommittedChanges → true) and sessionCommit proceeds
 * past the clean-tree short-circuit into the mt#2935 detection-time policy
 * consult. When `claudeMdContent` is provided it is written as the repo's
 * CLAUDE.md — the policy corpus `loadAllPolicySources(workdir)` reads.
 */
async function makeTmpDirtyGitRepo(claudeMdContent?: string): Promise<string> {
  const dir = await makeTmpCleanGitRepo();
  /* eslint-disable custom/no-real-fs-in-tests -- policy loaders read from disk directly (no DI seam) */
  if (claudeMdContent !== undefined) {
    await writeFile(join(dir, "CLAUDE.md"), claudeMdContent);
  } else {
    await writeFile(join(dir, "dirty.txt"), "uncommitted change\n");
  }
  /* eslint-enable custom/no-real-fs-in-tests */
  return dir;
}

/**
 * Fake SQL-capable persistence provider whose db captures inserted event
 * rows. `emitSystemEventFromProvider` duck-types `getDatabaseConnection` and
 * runs `db.insert(table).values(row)` via DrizzleEventEmitter.tryEmit — the
 * stub chain below satisfies exactly that path and records each row.
 */
function makeCapturingPersistenceProvider(): {
  provider: PersistenceProvider;
  rows: Array<Record<string, unknown>>;
} {
  const rows: Array<Record<string, unknown>> = [];
  const fakeDb = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        rows.push(row);
      },
    }),
  };
  const provider = {
    getDatabaseConnection: async () => fakeDb,
  } as unknown as PersistenceProvider;
  return { provider, rows };
}

/** Provider whose connection is unavailable — event persistence always fails. */
function makeDeadPersistenceProvider(): PersistenceProvider {
  return {
    getDatabaseConnection: async () => null,
  } as unknown as PersistenceProvider;
}

const COVERING_CLAUDE_MD =
  "# Project Instructions\n\nCommits and pushes in session workspaces are pre-approved by standing policy.\n";

/** Shared Ask-kind literal (avoids magic-string duplication across the test cases below). */
const KIND_AUTH_APPROVE = "authorization.approve";

// Track temp dirs created during the suite so we can clean up.
const tmpDirs: string[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {}); // eslint-disable-line custom/no-real-fs-in-tests -- cleanup for real tmp git repos created above
  }
});

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

  test("emits zero Asks when working tree is clean (nothing-to-commit path)", async () => {
    // Use a real git repo in clean state so hasUncommittedChanges returns false.
    const cleanRepoDir = await makeTmpCleanGitRepo();
    tmpDirs.push(cleanRepoDir);

    const record = makeSessionRecord({ sessionId: "clean-tree-session" });
    const sessionProvider = makeSessionProvider(record, cleanRepoDir);
    const askRepo = new FakeAskRepository();

    // sessionCommit should detect the clean tree upfront and return nothingToCommit
    // without ever emitting an Ask.
    const result = await sessionCommit(
      { session: "clean-tree-session", message: "chore: nothing to commit" },
      sessionProvider,
      askRepo
    );

    expect(result.success).toBe(true);
    expect(result.nothingToCommit).toBe(true);
    // No Ask should have been emitted for a clean-tree attempt.
    expect(askRepo.all).toHaveLength(0);
  });

  test("amend=true on a clean tree bypasses the nothing-to-commit short-circuit", async () => {
    // An amend commit may legitimately update only the commit message without new
    // file changes. The clean-tree short-circuit must NOT fire in this case.
    // Use a real clean git repo to ensure hasUncommittedChanges returns false.
    const cleanRepoDir = await makeTmpCleanGitRepo();
    tmpDirs.push(cleanRepoDir);

    const record = makeSessionRecord({ sessionId: "amend-session" });
    const sessionProvider = makeSessionProvider(record, cleanRepoDir);
    const askRepo = new FakeAskRepository();

    // sessionCommit with amend=true should NOT return nothingToCommit even though
    // the tree is clean. It proceeds past the short-circuit, reaches the git amend
    // call (which fails in this test environment because it tries to push),
    // and emits the Ask before the git call.
    type CommitResult = Awaited<ReturnType<typeof sessionCommit>>;
    let commitResult: CommitResult | undefined;
    let commitError: Error | undefined;
    try {
      commitResult = await sessionCommit(
        { session: "amend-session", message: "fix: amended message", amend: true },
        sessionProvider,
        askRepo
      );
    } catch (e: unknown) {
      commitError = e instanceof Error ? e : new Error(String(e));
    }

    // If it threw (git/push fails in test env), the short-circuit was skipped.
    // If it returned a result, nothingToCommit must be absent/false.
    if (commitError !== undefined) {
      // Reached the git/push step — short-circuit was definitely skipped.
      // The Ask should have been emitted before the failure.
      expect(askRepo.all).toHaveLength(1);
      expect(askRepo.all[0]?.kind).toBe(KIND_AUTH_APPROVE);
    } else {
      // Should not have hit nothingToCommit path.
      expect(commitResult?.nothingToCommit).toBeFalsy();
    }
  });
});

describe("sessionCommit detection-time policy consult (mt#2935)", () => {
  test("policy-covered commit emits ZERO asks and ONE authorization.policy_covered event", async () => {
    const workdir = await makeTmpDirtyGitRepo(COVERING_CLAUDE_MD);
    tmpDirs.push(workdir);

    const record = makeSessionRecord({ sessionId: "covered-session" });
    const sessionProvider = makeSessionProvider(record, workdir);
    const askRepo = new FakeAskRepository();
    const { provider, rows } = makeCapturingPersistenceProvider();

    // The commit itself may fail later (no origin remote in the tmp repo);
    // the detection-time consult runs before that, so assertions hold either way.
    await sessionCommit(
      { session: "covered-session", message: "feat: covered commit" },
      sessionProvider,
      askRepo,
      undefined,
      provider
    ).catch(() => {});

    expect(askRepo.all).toHaveLength(0);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("Expected one event row");
    expect(row.eventType).toBe("authorization.policy_covered");
    const payload = row.payload as Record<string, unknown>;
    expect(payload.action).toBe("commit");
    expect(payload.citationSource).toBe("CLAUDE.md");
    expect(payload.commitMessage).toBe("feat: covered commit");
    expect(row.relatedSessionId).toBe("covered-session");
  });

  test("covered-but-unpersisted event falls back to Ask emission (never silently unrecorded)", async () => {
    const workdir = await makeTmpDirtyGitRepo(COVERING_CLAUDE_MD);
    tmpDirs.push(workdir);

    const record = makeSessionRecord({ sessionId: "dead-provider-session" });
    const sessionProvider = makeSessionProvider(record, workdir);
    const askRepo = new FakeAskRepository();

    await sessionCommit(
      { session: "dead-provider-session", message: "feat: covered but no event store" },
      sessionProvider,
      askRepo,
      undefined,
      makeDeadPersistenceProvider()
    ).catch(() => {});

    // Event could not persist → the ask is the record.
    expect(askRepo.all).toHaveLength(1);
    expect(askRepo.all[0]?.kind).toBe(KIND_AUTH_APPROVE);
  });

  test("policy-silent commit still emits exactly one Ask and zero covered-events", async () => {
    const workdir = await makeTmpDirtyGitRepo(); // dirty repo, no CLAUDE.md
    tmpDirs.push(workdir);

    const record = makeSessionRecord({ sessionId: "uncovered-session" });
    const sessionProvider = makeSessionProvider(record, workdir);
    const askRepo = new FakeAskRepository();
    const { provider, rows } = makeCapturingPersistenceProvider();

    await sessionCommit(
      { session: "uncovered-session", message: "feat: uncovered commit" },
      sessionProvider,
      askRepo,
      undefined,
      provider
    ).catch(() => {});

    expect(askRepo.all).toHaveLength(1);
    expect(askRepo.all[0]?.kind).toBe(KIND_AUTH_APPROVE);
    expect(rows).toHaveLength(0);
  });

  test("covered path without a persistence provider falls back to Ask emission", async () => {
    const workdir = await makeTmpDirtyGitRepo(COVERING_CLAUDE_MD);
    tmpDirs.push(workdir);

    const record = makeSessionRecord({ sessionId: "no-provider-session" });
    const sessionProvider = makeSessionProvider(record, workdir);
    const askRepo = new FakeAskRepository();

    await sessionCommit(
      { session: "no-provider-session", message: "feat: covered, provider absent" },
      sessionProvider,
      askRepo
    ).catch(() => {});

    expect(askRepo.all).toHaveLength(1);
    expect(askRepo.all[0]?.kind).toBe(KIND_AUTH_APPROVE);
  });

  test("covered path with persistence provider but NO ask repository emits the event and creates no ask", async () => {
    // PR #2068 R1 BLOCKING: the detection-time consult was previously gated
    // entirely behind `if (askRepository)`, so a caller supplying only a
    // persistenceProvider (no askRepository) got neither an event nor an ask
    // — silently unrecorded. The gate must run whenever EITHER substrate is
    // present; only the fallback ask-creation itself requires askRepository.
    const workdir = await makeTmpDirtyGitRepo(COVERING_CLAUDE_MD);
    tmpDirs.push(workdir);

    const record = makeSessionRecord({ sessionId: "no-ask-repo-session" });
    const sessionProvider = makeSessionProvider(record, workdir);
    const { provider, rows } = makeCapturingPersistenceProvider();

    await sessionCommit(
      { session: "no-ask-repo-session", message: "feat: covered, no ask repo" },
      sessionProvider,
      undefined,
      undefined,
      provider
    ).catch(() => {});

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("Expected one event row");
    expect(row.eventType).toBe("authorization.policy_covered");
  });
});
