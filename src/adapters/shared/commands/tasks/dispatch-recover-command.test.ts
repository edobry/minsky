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
import {
  createTasksDispatchRecoverCommand,
  promptTypeForRecovery,
  buildTrackerUnavailableResponse,
} from "./dispatch-recover-command";
import type {
  DispatchRecoveryGitOps,
  DispatchRecoveryActivityOps,
} from "./dispatch-recover-command";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import { SessionStatus } from "@minsky/domain/session/types";
import type { SessionRecord } from "@minsky/domain/session/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import { FakeTaskService } from "@minsky/domain/tasks/fake-task-service";
import type {
  SubagentInvocationRecord,
  SubagentInvocationInsert,
  SubagentInvocationOutcome,
} from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { DISPATCH_RECOVERY_STALE_MS } from "@minsky/domain/session/dispatch-recovery-classifier";
import {
  PROMPT_TYPE_TO_AGENT_TYPE,
  PROMPT_WATERMARK,
  type PromptType,
} from "@minsky/domain/session/prompt-generation";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const CRASHED_NO_OUTPUT: SubagentInvocationOutcome = "crashed-no-output";
const PARTIAL_UNCOMMITTED_NO_HANDOFF: SubagentInvocationOutcome = "partial-uncommitted-no-handoff";
/** mt#3017: the dispatch-recover command's degraded-response status when the tracker is unavailable. */
const TRACKER_UNAVAILABLE_STATUS = "tracker-unavailable";
/** mt#3149: the escalation message's redispatch-warning fragment, asserted from multiple tests. */
const DO_NOT_REDISPATCH_WARNING = "Do NOT redispatch";

// ---------------------------------------------------------------------------
// Fake tracker — duck-typed, implements only what the command calls.
// ---------------------------------------------------------------------------

class FakeTracker {
  private rows = new Map<string, SubagentInvocationRecord>();
  private nextId = 1;
  public recordedAttempts: Array<SubagentInvocationInsert & { attemptNumber: number }> = [];
  /** Every `recordSubagentInvocation` call this fake received (mt#2831 R1 — the original-row closeout). */
  public recordedInvocationCalls: SubagentInvocationInsert[] = [];

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

  /**
   * mt#2831 R1: the command now closes out the ORIGINAL row (by `id`) before
   * inserting the resumed attempt. This fake mirrors the real tracker's
   * strong-binding UPDATE-by-id path closely enough for the command's tests:
   * when `input.id` matches an existing row, update it in place; otherwise
   * insert (matching the real tracker's fallback-to-insert behavior).
   */
  async recordSubagentInvocation(input: SubagentInvocationInsert): Promise<string | null> {
    this.recordedInvocationCalls.push(input);
    if (input.id && this.rows.has(input.id)) {
      const existing = this.rows.get(input.id) as SubagentInvocationRecord;
      const updated: SubagentInvocationRecord = {
        ...existing,
        ...input,
        id: existing.id,
        startedAt: existing.startedAt,
        endedAt:
          input.endedAt === undefined
            ? existing.endedAt
            : input.endedAt instanceof Date
              ? input.endedAt
              : input.endedAt
                ? new Date(input.endedAt as never)
                : null,
      } as SubagentInvocationRecord;
      this.rows.set(existing.id, updated);
      return existing.id;
    }
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

// mt#3086: fake presence-claim-derived activity ops — defaults to "no
// signal" (matches pre-mt#3086 behavior when a test doesn't care about it).
function makeActivityOps(
  overrides: Partial<DispatchRecoveryActivityOps> = {}
): DispatchRecoveryActivityOps {
  return {
    lastPresenceActivityAtMs: async () => null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Deliberately throws on any access — exercises the command's fail-open handling of
// getTaskService().getTaskStatus() (mt#2831 R1 NB #3: an unresolvable status must not
// block recovery). Tests that care about the task-status guard's actual VALUE use
// FakeTaskService instead (see makeCommand's `taskService` override below).
const throwingTaskService = new Proxy(
  {},
  {
    get() {
      throw new Error("taskService intentionally throws — exercises fail-open handling");
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
  tracker: FakeTracker | null;
  sessionProvider: FakeSessionProvider;
  gitOps?: DispatchRecoveryGitOps;
  activityOps?: DispatchRecoveryActivityOps;
  staleMs?: number;
  taskService?: TaskServiceInterface;
}) {
  return createTasksDispatchRecoverCommand(
    async () => opts.sessionProvider,
    () => opts.taskService ?? throwingTaskService,
    async () => opts.tracker as never,
    () => undefined,
    {
      gitOps: opts.gitOps ?? makeGitOps(),
      activityOps: opts.activityOps ?? makeActivityOps(),
      now: () => NOW,
      staleMs: opts.staleMs,
    }
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
    expect(result.activitySource).toBe("commit");
    // No recovery attempt was recorded — nothing touched.
    expect(tracker.recordedAttempts).toHaveLength(0);
    expect(tracker.recordedInvocationCalls).toHaveLength(0);
  });

  // mt#3086 AT1: "Simulated alive-but-quiet dispatch (recent transcript
  // activity, no commits) -> recover returns healthy." No commits at all —
  // only presence-claim (session-scoped MCP tool-call) activity — is enough
  // to keep the dispatch classified healthy, closing the false-positive gap
  // the mt#3086 originating incident hit (a long local diagnosis loop with
  // no commits/PR events, misclassified as dead).
  test("alive-but-quiet dispatch (recent presence-claim activity, NO commits) -> healthy, no action (mt#3086 AT1)", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - 40 * 60 * 1000), // dispatched 40 min ago
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const gitOps = makeGitOps({ lastCommitAtMs: async () => null }); // no commits, ever
    const activityOps = makeActivityOps({
      // an MCP tool call (e.g. session_exec, session_read_file) 3 minutes ago
      lastPresenceActivityAtMs: async () => NOW.getTime() - 3 * 60 * 1000,
    });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps, activityOps });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("healthy");
    expect(result.activitySource).toBe("presence");
    expect(tracker.recordedAttempts).toHaveLength(0);
    expect(tracker.recordedInvocationCalls).toHaveLength(0);
  });

  // mt#3086 AT2: "Simulated dead dispatch (stale transcript, no process) ->
  // recover with continuation prompt, as today." A stale/absent presence
  // signal must NOT change the pre-existing recover outcome.
  test("genuinely dead dispatch (no commits, stale/absent presence activity) -> still recover, unchanged (mt#3086 AT2)", async () => {
    const tracker = new FakeTracker();
    const original = tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const gitOps = makeGitOps({ lastCommitAtMs: async () => null });
    // Presence activity, if any, is long past the stale window too.
    const activityOps = makeActivityOps({
      lastPresenceActivityAtMs: async () => NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 500,
    });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps, activityOps });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("recover");
    expect(result.resumedFromInvocationId).toBe(original.id);
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
    // The NEW (resumed) row always gets the pessimistic dispatch-time-convention
    // default outcome, never the classification — the classification describes the
    // ORIGINAL attempt's final state, recorded on the ORIGINAL row instead (see the
    // "closes out the ORIGINAL row" test below). In this fixture the two happen to
    // be the same VALUE (crashed-no-output) by coincidence of the scenario (no
    // commits, no dirty files) — the assertion below on recordedInvocationCalls is
    // what actually distinguishes "pessimistic default" from "classification".
    expect(tracker.recordedAttempts[0]?.outcome).toBe(CRASHED_NO_OUTPUT);
  });

  test("continuationPrompt carries the session.generate_prompt watermark (mt#2947 — dispatch-guard compatibility)", async () => {
    // Regression test for mt#2947: the PreToolUse dispatch guard
    // (.minsky/hooks/check-prompt-watermark.ts) denies any Agent-tool prompt
    // that references a session workspace directory (which every recovery
    // continuationPrompt does) unless it carries the `<!-- minsky:prompt:v1 -->`
    // watermark emitted by `generateSubagentPrompt`. Before mt#2947, this
    // command hand-assembled the prompt string directly and never carried the
    // watermark — the documented "redispatch verbatim via the Agent tool"
    // protocol was guard-rejected on every attempt.
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const cmd = makeCommand({ tracker, sessionProvider });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.status).toBe("recover");
    const prompt = result.continuationPrompt as string;
    // Assert against the ACTUAL constant `generateSubagentPrompt` emits (rather than a
    // hand-duplicated literal) so this test can't silently drift from the real marker if
    // it's ever renamed — and against the exact predicate the dispatch guard's
    // `hasWatermark()` (`.minsky/hooks/check-prompt-watermark.ts`) uses: `includes()`.
    expect(prompt.includes(PROMPT_WATERMARK)).toBe(true);
    // The recovery-specific narrative is still present, embedded as the
    // generated prompt's instructions body — this proves the wrap is
    // additive (header + envelope + watermark), not a replacement of the
    // classification-specific guidance.
    expect(prompt).toContain("fresh start");
    expect(prompt).toContain("mt#2831");
  });

  test("closes out the ORIGINAL row with the classification + endedAt before inserting the resumed attempt (mt#2831 R1)", async () => {
    const tracker = new FakeTracker();
    const original = tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    // Dirty tree, no handoff -> classification is partial-uncommitted-no-handoff —
    // deliberately DIFFERENT from the resumed row's pessimistic crashed-no-output
    // default, so this test can distinguish the two rather than coincide with them.
    const gitOps = makeGitOps({
      status: async () => ({ staged: ["a.ts"], unstaged: [], untracked: [] }),
    });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps });

    await cmd.execute({ taskId: "mt#2831" } as never);

    expect(tracker.recordedInvocationCalls).toHaveLength(1);
    const closeoutCall = tracker.recordedInvocationCalls[0];
    expect(closeoutCall?.id).toBe(original.id);
    expect(closeoutCall?.outcome).toBe(PARTIAL_UNCOMMITTED_NO_HANDOFF);
    expect(closeoutCall?.endedAt).toBeInstanceOf(Date);

    // The NEW row is untouched by the classification — it keeps the pessimistic
    // default, not PARTIAL_UNCOMMITTED_NO_HANDOFF.
    expect(tracker.recordedAttempts).toHaveLength(1);
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

    expect(result.classification).toBe(PARTIAL_UNCOMMITTED_NO_HANDOFF);
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

    // No 3rd attempt was recorded, and neither row was touched (escalation is
    // read-only against the existing chain).
    expect(tracker.recordedAttempts).toHaveLength(0);
    expect(tracker.recordedInvocationCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // mt#3149: escalate path must re-probe live state, not echo a stale/
  // pessimistic-default DB outcome — the originating incident (PR #2244 open
  // with pushed commits, reported crashed-no-output twice at the 2-attempt
  // bound) happened entirely inside this branch.
  // ---------------------------------------------------------------------------
  describe("mt#3149: escalate path re-probes live state (PR/commits liveness)", () => {
    function seedTwoAttemptChain(tracker: FakeTracker) {
      const original = tracker.seed({
        taskId: "mt#2831",
        subagentSessionId: "sess-1",
        startedAt: new Date(NOW.getTime() - 3 * DISPATCH_RECOVERY_STALE_MS),
        endedAt: new Date(NOW.getTime() - 2 * DISPATCH_RECOVERY_STALE_MS),
        outcome: CRASHED_NO_OUTPUT,
        attemptNumber: 1,
      });
      const resumed = tracker.seed({
        taskId: "mt#2831",
        subagentSessionId: "sess-1",
        startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
        resumedFromInvocationId: original.id,
        attemptNumber: 2,
        // Pessimistic placeholder written at resume time — matches the real
        // tracker's `recordDispatchRecoveryAttempt` convention. This is the
        // exact stale value the pre-mt#3149 code echoed unchanged.
        outcome: CRASHED_NO_OUTPUT,
      });
      return { original, resumed };
    }

    test("replay: dispatch opened a PR and continues working past the stale window -> escalate reports committed-no-pr for the latest attempt, NOT crashed-no-output (mt#3149 AT1)", async () => {
      const tracker = new FakeTracker();
      const { resumed } = seedTwoAttemptChain(tracker);
      const sessionProvider = new FakeSessionProvider({
        initialSessions: [
          makeSessionRecord({
            pullRequest: {
              number: 2244,
              url: "https://github.com/edobry/minsky/pull/2244",
              state: "open",
              createdAt: new Date().toISOString(),
              headBranch: "task/mt-2831",
              baseBranch: "main",
              lastSynced: new Date().toISOString(),
            },
          }),
        ],
      });
      // commitsAheadOfBase deliberately reads 0 here — reproducing the exact
      // originating-incident shape where the PR alone must be enough.
      const gitOps = makeGitOps({ commitsAheadOfBase: async () => 0 });
      const cmd = makeCommand({ tracker, sessionProvider, gitOps });

      const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

      expect(result.status).toBe("escalate");
      const escalation = result.escalation as {
        attempts: Array<{ invocationId: string; outcome: string | null }>;
        hasLivenessEvidence: boolean;
        message: string;
      };
      const latestEntry = escalation.attempts.find((a) => a.invocationId === resumed.id);
      expect(latestEntry?.outcome).toBe("committed-no-pr");
      expect(latestEntry?.outcome).not.toBe(CRASHED_NO_OUTPUT);
      expect(escalation.hasLivenessEvidence).toBe(true);
      expect(escalation.message).toContain("NOT confirmed death");
      expect(escalation.message).toContain(DO_NOT_REDISPATCH_WARNING);
      expect(escalation.message).toContain("#2244");
    });

    test("dispatch has commits ahead of base (no PR yet) -> escalate reports committed-no-pr for the latest attempt, warns against redispatch (mt#3149 AT2)", async () => {
      const tracker = new FakeTracker();
      const { resumed } = seedTwoAttemptChain(tracker);
      const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
      const gitOps = makeGitOps({ commitsAheadOfBase: async () => 7 });
      const cmd = makeCommand({ tracker, sessionProvider, gitOps });

      const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

      expect(result.status).toBe("escalate");
      const escalation = result.escalation as {
        attempts: Array<{ invocationId: string; outcome: string | null }>;
        hasLivenessEvidence: boolean;
        message: string;
      };
      const latestEntry = escalation.attempts.find((a) => a.invocationId === resumed.id);
      expect(latestEntry?.outcome).toBe("committed-no-pr");
      expect(escalation.hasLivenessEvidence).toBe(true);
      expect(escalation.message).toContain(DO_NOT_REDISPATCH_WARNING);
      expect(escalation.message).toContain("7 commit(s) ahead of base");
    });

    // Acceptance Test 4 (HARD CONSTRAINT): the fix must not make the escalate
    // path permissive — a genuinely dead dispatch (no PR, no commits, no dirty
    // files) must still escalate with crashed-no-output for the latest attempt.
    test("genuinely dead dispatch (no PR, no commits, clean tree) -> escalate still reports crashed-no-output (mt#3149 AT4 hard constraint)", async () => {
      const tracker = new FakeTracker();
      const { resumed } = seedTwoAttemptChain(tracker);
      const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
      const gitOps = makeGitOps({ commitsAheadOfBase: async () => 0 });
      const cmd = makeCommand({ tracker, sessionProvider, gitOps });

      const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

      expect(result.status).toBe("escalate");
      const escalation = result.escalation as {
        attempts: Array<{ invocationId: string; outcome: string | null }>;
        hasLivenessEvidence: boolean;
        message: string;
      };
      const latestEntry = escalation.attempts.find((a) => a.invocationId === resumed.id);
      expect(latestEntry?.outcome).toBe(CRASHED_NO_OUTPUT);
      expect(escalation.hasLivenessEvidence).toBe(false);
      expect(escalation.message).toContain("2-attempt bound");
      expect(escalation.message).not.toContain(DO_NOT_REDISPATCH_WARNING);
    });

    test("older (already-closed) attempts in the chain keep their stored outcome — only the latest open row is re-probed", async () => {
      const tracker = new FakeTracker();
      const { original, resumed } = seedTwoAttemptChain(tracker);
      const sessionProvider = new FakeSessionProvider({
        initialSessions: [
          makeSessionRecord({
            pullRequest: {
              number: 55,
              url: "https://github.com/edobry/minsky/pull/55",
              state: "open",
              createdAt: new Date().toISOString(),
              headBranch: "task/mt-2831",
              baseBranch: "main",
              lastSynced: new Date().toISOString(),
            },
          }),
        ],
      });
      const cmd = makeCommand({ tracker, sessionProvider });

      const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

      const escalation = result.escalation as {
        attempts: Array<{ invocationId: string; outcome: string | null }>;
      };
      const originalEntry = escalation.attempts.find((a) => a.invocationId === original.id);
      const latestEntry = escalation.attempts.find((a) => a.invocationId === resumed.id);
      // The original row's stored outcome (a real classification from its own
      // closure) is untouched.
      expect(originalEntry?.outcome).toBe(CRASHED_NO_OUTPUT);
      // The latest (open) row is corrected from its placeholder to the live probe.
      expect(latestEntry?.outcome).toBe("committed-no-pr");
    });
  });

  test("mt#3149 Acceptance Test: a dispatch whose branch has commits ahead of base reports that count in stateSummary on the recover path, not commitsAheadOfBase: 0", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const gitOps = makeGitOps({ commitsAheadOfBase: async () => 9 });
    const cmd = makeCommand({ tracker, sessionProvider, gitOps });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.status).toBe("recover");
    const stateSummary = result.stateSummary as { commitsAheadOfBase: number | null };
    expect(stateSummary.commitsAheadOfBase).toBe(9);
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

  test("task status outside IN-PROGRESS/IN-REVIEW (e.g. DONE) -> not-in-flight, tracker untouched (mt#2831 R1 NB #3)", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const taskService = new FakeTaskService({
      initialTasks: [{ id: "mt#2831", title: "fixture", status: "DONE" }],
    });
    const cmd = makeCommand({ tracker, sessionProvider, taskService });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("not-in-flight");
    expect(result.message as string).toContain("DONE");
    // The guard fires BEFORE any tracker read/write.
    expect(tracker.recordedAttempts).toHaveLength(0);
    expect(tracker.recordedInvocationCalls).toHaveLength(0);
  });

  test("task status IN-REVIEW proceeds normally (guard is not IN-PROGRESS-only)", async () => {
    const tracker = new FakeTracker();
    tracker.seed({
      taskId: "mt#2831",
      subagentSessionId: "sess-1",
      startedAt: new Date(NOW.getTime() - DISPATCH_RECOVERY_STALE_MS - 1000),
    });
    const sessionProvider = new FakeSessionProvider({ initialSessions: [makeSessionRecord()] });
    const taskService = new FakeTaskService({
      initialTasks: [{ id: "mt#2831", title: "fixture", status: "IN-REVIEW" }],
    });
    const cmd = makeCommand({ tracker, sessionProvider, taskService });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe("recover");
  });

  // ---------------------------------------------------------------------------
  // mt#3017: tracker-unavailable degraded response (SC3/SC4)
  // ---------------------------------------------------------------------------

  test("tracker unavailable -> structured tracker-unavailable response with manual fallback steps (mt#3017 SC3)", async () => {
    const sessionProvider = new FakeSessionProvider({
      initialSessions: [makeSessionRecord({ taskId: "mt#2831" })],
    });
    const cmd = makeCommand({ tracker: null, sessionProvider });

    const result = (await cmd.execute({ taskId: "mt#2831" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.status).toBe(TRACKER_UNAVAILABLE_STATUS);
    expect(result.error as string).toContain("tracker unavailable");
    expect(result.taskId).toBe("mt#2831");

    const manualFallback = result.manualFallback as {
      message: string;
      steps: string[];
      classificationGuide: string;
      retryGuidance: string;
    };
    expect(manualFallback).toBeDefined();
    expect(manualFallback.steps.length).toBeGreaterThan(0);
    // Each named manual step must map to a concrete, runnable command an
    // operator can execute by hand — not a vague description.
    expect(manualFallback.steps.some((s) => s.includes("git status"))).toBe(true);
    expect(manualFallback.steps.some((s) => s.includes("handoff.md"))).toBe(true);
    expect(manualFallback.steps.some((s) => s.includes("git rev-list"))).toBe(true);
    expect(manualFallback.classificationGuide).toContain(PARTIAL_UNCOMMITTED_NO_HANDOFF);
    expect(manualFallback.retryGuidance.length).toBeGreaterThan(0);

    // Session lookup is best-effort and independent of the tracker — since a
    // session IS seeded for this task, the response should name it concretely
    // rather than falling back to fully generic guidance.
    expect(result.sessionId).toBe("sess-1");
    expect(result.sessionDir).toBeTruthy();
  });

  test("tracker unavailable + no session found for the task -> generic guidance, sessionId/sessionDir null", async () => {
    const sessionProvider = new FakeSessionProvider(); // no seeded sessions
    const cmd = makeCommand({ tracker: null, sessionProvider });

    const result = (await cmd.execute({ taskId: "mt#404" } as never)) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.status).toBe(TRACKER_UNAVAILABLE_STATUS);
    expect(result.sessionId).toBeNull();
    expect(result.sessionDir).toBeNull();

    const manualFallback = result.manualFallback as { message: string };
    expect(manualFallback.message).toContain("session_get");
  });
});

// ---------------------------------------------------------------------------
// buildTrackerUnavailableResponse (mt#3017) — direct unit coverage of the
// helper, including its own best-effort session-provider failure handling.
// ---------------------------------------------------------------------------

describe("buildTrackerUnavailableResponse", () => {
  test("session provider throws -> falls back to generic guidance instead of propagating", async () => {
    const throwingSessionProvider = async () => {
      throw new Error("session provider unavailable — exercises the best-effort fallback");
    };

    const response = await buildTrackerUnavailableResponse("mt#2831", throwingSessionProvider);

    expect(response.success).toBe(false);
    expect(response.status).toBe(TRACKER_UNAVAILABLE_STATUS);
    expect(response.sessionId).toBeNull();
    expect(response.sessionDir).toBeNull();
    expect(response.manualFallback.steps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// promptTypeForRecovery (mt#2947)
// ---------------------------------------------------------------------------

describe("promptTypeForRecovery", () => {
  const agentTypeToPromptType = Object.fromEntries(
    Object.entries(PROMPT_TYPE_TO_AGENT_TYPE).map(([promptType, agent]) => [agent, promptType])
  ) as Record<string, PromptType>;

  test("implementer -> implementation", () => {
    expect(promptTypeForRecovery("implementer", agentTypeToPromptType)).toBe("implementation");
  });

  test("refactorer -> refactor (write-capable, honored)", () => {
    expect(promptTypeForRecovery("refactorer", agentTypeToPromptType)).toBe("refactor");
  });

  test("cleaner -> cleanup (write-capable, honored)", () => {
    expect(promptTypeForRecovery("cleaner", agentTypeToPromptType)).toBe("cleanup");
  });

  test("reviewer maps to the read-only 'review' PromptType but is forced to 'implementation' (guidance is write-oriented)", () => {
    expect(promptTypeForRecovery("reviewer", agentTypeToPromptType)).toBe("implementation");
  });

  test("auditor maps to the read-only 'audit' PromptType but is forced to 'implementation'", () => {
    expect(promptTypeForRecovery("auditor", agentTypeToPromptType)).toBe("implementation");
  });

  test("unmapped/legacy agent type (e.g. general-purpose) falls back to implementation", () => {
    expect(promptTypeForRecovery("general-purpose", agentTypeToPromptType)).toBe("implementation");
  });
});
