/**
 * tasks.dispatch-recover unit tests (mt#2831).
 *
 * Covers the acceptance-test set from the mt#2831 spec at the unit level
 * (the full "kill a real dispatched subagent -> auto-resume" acceptance test
 * cannot run pre-merge from a session — see the PR body's UNVERIFIED /
 * discharge-plan note):
 *
 *   - Classification against fixture invocation/session states (all 4
 *     outcome classes, driven through injected git ops — no real subprocess).
 *   - Retry-linkage recording (resumedFromInvocationId / attemptNumber).
 *   - The 2-attempt refusal (3rd recover call for the same chain escalates).
 *   - Healthy no-action (false-positive-kill acceptance test).
 *
 * All I/O is faked: `DispatchRecoveryGitOps` is injected (no real `git`
 * spawned), the session provider is `FakeSessionProvider`, the task tracker
 * is a minimal duck-typed fake implementing only the 3 methods the command
 * calls. No real subagents are dispatched — the command never dispatches
 * anything; it only returns a prompt for the CALLER to redispatch.
 */
import { describe, test, expect } from "bun:test";
import { createTasksDispatchRecoverCommand } from "./dispatch-recover-command";
import type { DispatchRecoveryGitOps } from "./dispatch-recover-command";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import { SessionStatus } from "@minsky/domain/session/types";
import type { SessionRecord } from "@minsky/domain/session/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type {
  SubagentInvocationRecord,
  SubagentInvocationInsert,
  SubagentInvocationOutcome,
} from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { DISPATCH_RECOVERY_STALE_MS } from "@minsky/domain/session/dispatch-recovery-classifier";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const CRASHED_NO_OUTPUT: SubagentInvocationOutcome = "crashed-no-output";

// ---------------------------------------------------------------------------
// Fake tracker — duck-typed, implements only what the command calls.
// ---------------------------------------------------------------------------

class FakeTracker {
  private rows = new Map<string, SubagentInvocationRecord>();
  private nextId = 1;
  public recordedAttempts: Array<SubagentInvocationInsert & { attemptNumber: number }> = [];

  seed(row: Partial<SubagentInvocationRecord> & { taskId: string }): SubagentInvocationRecord {
    const full: SubagentInvocationRecord = {
      id: row.id ?? `row-${this.nextId++}`,
      taskId: row.taskId,
      sessionId: row.sessionId ?? null,
      agentSessionId: row.agentSessionId ?? null,
      parentSessionId: row.parentSessionId ?? null,
      parentTaskId: row.parentTaskId ?? null,
      subagentSessionId: row.subagentSessionId ?? null,
      agentType: row.agentType ?? "implementer",
      suggestedModel: row.suggestedModel ?? null,
      actualModel: row.actualModel ?? null,
      startedAt: row.startedAt ?? NOW,
      endedAt: row.endedAt ?? null,
      durationMs: row.durationMs ?? null,
      toolUseCount: row.toolUseCount ?? null,
      totalTokens: row.totalTokens ?? null,
      outcome: row.outcome ?? ("crashed-no-output" as SubagentInvocationOutcome),
      errorSummary: row.errorSummary ?? null,
      summary: row.summary ?? null,
      prUrl: row.prUrl ?? null,
      lastCommitHash: row.lastCommitHash ?? null,
      handoffWritten: row.handoffWritten ?? null,
      resumedFromInvocationId: row.resumedFromInvocationId ?? null,
      attemptNumber: row.attemptNumber ?? 1,
    };
    this.rows.set(full.id, full);
    return full;
  }

  async getLatestInvocationForTask(taskId: string): Promise<SubagentInvocationRecord | null> {
    const matches = Array.from(this.rows.values())
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return matches[0] ?? null;
  }

  async getInvocationChainForTask(taskId: string): Promise<SubagentInvocationRecord[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  async recordDispatchRecoveryAttempt(
    input: SubagentInvocationInsert & { resumedFromInvocationId: string; attemptNumber: number }
  ): Promise<string | null> {
    this.recordedAttempts.push(input);
    const row = this.seed({
      ...input,
      taskId: input.taskId,
      startedAt:
        input.startedAt instanceof Date ? input.startedAt : new Date(input.startedAt as never),
    });
    return row.id;
  }
}

// ---------------------------------------------------------------------------
// Fake git ops
// ---------------------------------------------------------------------------

function makeGitOps(overrides: Partial<DispatchRecoveryGitOps> = {}): DispatchRecoveryGitOps {
  return {
    status: async () => ({ staged: [], unstaged: [], untracked: [] }),
    lastCommitAtMs: async () => null,
    detectDefaultBranch: async () => "main",
    commitsAheadOfBase: async () => 0,
    readHandoff: async () => null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const throwingTaskService = new Proxy(
  {},
  {
    get() {
      throw new Error("taskService should not be reached in these tests");
    },
  }
) as TaskServiceInterface;

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess-1",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#2831",
    status: SessionStatus.ACTIVE,
    ...overrides,
  };
}

function makeCommand(opts: {
  tracker: FakeTracker;
  sessionProvider: FakeSessionProvider;
  gitOps?: DispatchRecoveryGitOps;
  staleMs?: number;
}) {
  return createTasksDispatchRecoverCommand(
    async () => opts.sessionProvider,
    () => throwingTaskService,
    () => opts.tracker as never,
    { gitOps: opts.gitOps ?? makeGitOps(), now: () => NOW, staleMs: opts.staleMs }
  );
}

describe("tasks.dispatch-recover", () => {
  test("no dispatch found for the task -> no-dispatch, no error", async () => {
    const tracker = new FakeTracker();
    const sessionProvider = new FakeSessionProvider();
    const cmd = makeCommand({ tracker, sessionProvider });

    const result = (await cmd.execute({ taskId: "mt#404" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("no-dispatch");
  });

  test("latest invocation already ended -> not-in-flight, no action", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      endedAt: NOW,
      outcome: "completed-with-pr" as SubagentInvocationOutcome,
    });
    const sessionProvider = new FakeSessionProvider();
    const cmd = makeCommand({ tracker, sessionProvider });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("not-in-flight");
  });

  test("healthy long-running dispatch (recent commit) -> healthy, no action (false-positive-kill guard)", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - 40 * 60 * 1000), // dispatched 40 min ago
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const gitOps = makeGitOps({
      // last commit 5 minutes ago — well within the stale window
      lastCommitAtMs: async () => NOW.getTime() - 5 * 60 * 1000,
    });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("healthy");
    // No recovery attempt was recorded — nothing touched.
    expect(tracker.recordedAttempts).toHaveLength(0);
  });

  test("stale, clean tree, no commits -> crashed-no-output, continuation prompt returned, attempt recorded", async () => {
    const tracker = new FakeTracker();
    const original = tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const cmd = makeCommand({ tracker, sessionProvider });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("recover");
    expect(result.classification).toBe(CRASHED_NO_OUTPUT);
    expect(result.attemptNumber).toBe(2);
    expect(result.resumedFromInvocationId).toBe(original.id);
    expect(typeof result.continuationPrompt).toBe("string");
    expect(result.continuationPrompt as string).toContain("mt#2831");
    expect(result.continuationPrompt as string).toContain("fresh start");

    expect(tracker.recordedAttempts).toHaveLength(1);
    expect(tracker.recordedAttempts[0]?.resumedFromInvocationId).toBe(original.id);
    expect(tracker.recordedAttempts[0]?.attemptNumber).toBe(2);
    expect(tracker.recordedAttempts[0]?.outcome).toBe(CRASHED_NO_OUTPUT);
  });

  test("stale, dirty tree, no handoff -> partial-uncommitted-no-handoff", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const gitOps = makeGitOps({
      status: async () => ({ staged: ["a.ts"], unstaged: [], untracked: ["b.ts"] }),
    });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.classification).toBe("partial-uncommitted-no-handoff");
    expect(result.continuationPrompt as string).toContain("do NOT discard them");
  });

  test("stale, dirty tree, handoff present -> partial-committed-handoff-written, handoff content in prompt", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const gitOps = makeGitOps({
      status: async () => ({ staged: ["a.ts"], unstaged: [], untracked: [] }),
      readHandoff: async () => "Done: X\nRemaining: Y\n",
    });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.classification).toBe("partial-committed-handoff-written");
    expect(result.continuationPrompt as string).toContain("Done: X");
  });

  test("stale, clean tree, commits ahead, no PR -> committed-no-pr", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const gitOps = makeGitOps({ commitsAheadOfBase: async () => 3 });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.classification).toBe("committed-no-pr");
    expect(result.continuationPrompt as string).toContain("create the PR");
  });

  test("stale, clean tree, commits ahead, PR already open -> committed-no-pr with convergence guidance", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({
      initialSessions: [
        makeSessionRecord({
          pullRequest: {
            number: 4242,
            url: "https://github.com/edobry/minsky/pull/4242",
            state: "open",
            createdAt: new Date().toISOString(),
            headBranch: "task/mt-2831",
            baseBranch: "main",
            lastSynced: new Date().toISOString(),
          },
        }),
      ],
    });
    const gitOps = makeGitOps({ commitsAheadOfBase: async () => 3 });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.classification).toBe("committed-no-pr");
    expect(result.continuationPrompt as string).toContain("#4242");
    expect(result.continuationPrompt as string).toContain("drive it to convergence");
  });

  test("2-attempt bound: a 3rd recover call for the same chain refuses and escalates instead of resuming again", async () => {
    const tracker = new FakeTracker();
    // Simulate: original (attempt 1) already resumed once (attempt 2), and attempt 2 has
    // itself now gone stale again.
    const original = tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - 3 * DISPATCH_RECOVERY_STALE_MS),
      endedAt: new Date(NOW.getTime() - 2 * DISPATCH_RECOVERY_STALE_MS),
      outcome: CRASHED_NO_OUTPUT,
      attemptNumber: 1,
    });
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
      resumedFromInvocationId: original.id,
      attemptNumber: 2,
      outcome: CRASHED_NO_OUTPUT,
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const cmd = makeCommand({ tracker, sessionProvider });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("escalate");
    expect(result.continuationPrompt).toBeUndefined();
    const escalation = result.escalation as { attempts: unknown[]; message: string };
    expect(escalation.attempts).toHaveLength(2);
    expect(escalation.message).toContain("2-attempt bound");

    // No 3rd attempt was recorded.
    expect(tracker.recordedAttempts).toHaveLength(0);
  });

  test("missing subagentSessionId on the latest row -> a clear error, not a crash", async () => {
    const tracker = new FakeTracker();
    tracker.seed({ taskId: "mt#2831", subagentSessionId: null });
    const sessionProvider = new FakeSessionProvider();
    const cmd = makeCommand({ tracker, sessionProvider });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error as string).toContain("subagentSessionId");
  });
});
