/* eslint-disable custom/no-real-fs-in-tests -- resolveTranscriptCandidates walks the real on-disk <session>/subagents/ layout via readdirSync and existsSync, and readTranscriptMetrics reads real JSONL files; mirrors check-task-spec-read.test.ts's fixture pattern */
// Tests for the SubagentStop transcript-metrics path fix (mt#2649).
//
// Background-Agent-dispatched subagents receive `transcript_path` pointing at
// the PARENT session's top-level transcript, while the subagent's own
// tool_use/usage lines live at `<session-dir>/subagents/agent-<id>.jsonl`
// (mt#2637 diagnosis). This file verifies `resolveMetricsTranscriptPath`
// resolves to the per-agent file (not the parent) and that
// `readTranscriptMetrics` reading THAT file returns the per-agent counts —
// preserving the `agent_session_id` line-filter along the way.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveMetricsTranscriptPath,
  usedPerAgentTranscript,
  buildUnattributedModelWarning,
  decideRecordingAction,
  HOOK_UNKNOWN_TASK_ID,
  recordFailureBestEffort,
  recoverDispatchStamp,
  resolveRecordedClassification,
  __setDeadlineExceededForTest,
} from "./record-subagent-invocation";
import { buildDispatchStamp } from "./agent-dispatch-stamp";
import { UNKNOWN_TASK_ID } from "../../src/mcp/subagent-dispatch-tracker";
import { readTranscriptMetrics } from "../../packages/domain/src/subagent/transcript-metrics";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A transcript-metrics JSONL line with N tool_use blocks and optional usage/timestamp. */
function metricsLine(opts: {
  toolUseCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  timestamp?: string;
  agentSessionId?: string;
  /**
   * Harness agent id. Real per-agent transcripts carry this on every line
   * (verified 60/60 against on-disk `subagents/agent-<id>.jsonl` files), and
   * mt#3256 made attribution require a POSITIVE match — so a fixture standing
   * in for a per-agent file must set it, or it is not a faithful stand-in.
   */
  agentId?: string;
}): Record<string, unknown> {
  const blocks = Array.from({ length: opts.toolUseCount ?? 0 }, () => ({ type: "tool_use" }));
  // mt#4122: `role`, `content` and `usage` are nested under `message` — that is
  // what the harness emits, verified against real on-disk transcripts. This
  // fixture previously placed all three at the top level. The tests still
  // passed, because they were exercising a shape no producer emits; the reader
  // returned null for `tool_use_count` and `total_tokens` on every real
  // transcript for the corpus's entire lifetime and nothing here could see it.
  //
  // Note the comment on `agentId` above: that ONE field was verified 60/60
  // against real files while the fields beside it stayed assumed. A fixture is
  // only a stand-in for the shape it was actually checked against.
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: blocks,
      usage:
        opts.inputTokens != null || opts.outputTokens != null
          ? { input_tokens: opts.inputTokens ?? 0, output_tokens: opts.outputTokens ?? 0 }
          : undefined,
    },
    timestamp: opts.timestamp,
    agent_session_id: opts.agentSessionId,
    agentId: opts.agentId,
  };
}

function toJsonl(lines: Record<string, unknown>[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/**
 * Build an on-disk fixture mirroring the harness layout:
 *   <root>/<session-id>.jsonl                       (parent transcript)
 *   <root>/<session-id>/subagents/agent-<id>.jsonl  (per-agent transcript)
 * Returns both paths.
 */
function buildTranscriptTree(
  parentLines: Record<string, unknown>[],
  agentId: string,
  agentLines: Record<string, unknown>[]
): { parentPath: string; agentPath: string } {
  const root = mkdtempSync(join(tmpdir(), "record-subagent-invocation-"));
  fixtureRoots.push(root);
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const parentPath = join(root, `${sessionId}.jsonl`);
  writeFileSync(parentPath, toJsonl(parentLines));
  const subagentsDir = join(root, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const agentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(agentPath, toJsonl(agentLines));
  return { parentPath, agentPath };
}

// ---------------------------------------------------------------------------
// Recording decision — mt#3019 acceptance tests (PR #2178 R1 BLOCKING #3)
//
// These are the spec's hook-level edge cases: the null correlation key and the
// unresolved-taskId paths. The pre-mt#3019 bug survived precisely because
// tracker-level mocks stayed green while the hook never reached the tracker at
// all, so these assert the hook's OWN control flow.
// ---------------------------------------------------------------------------

const SESSION_CWD = "/Users/x/.local/state/minsky/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("decideRecordingAction (mt#3019)", () => {
  test("sentinel constant matches the tracker's, so the duplication cannot drift", () => {
    expect(HOOK_UNKNOWN_TASK_ID).toBe(UNKNOWN_TASK_ID);
  });

  test("no taskId and no session key -> skip, with a warning naming the cwd", () => {
    const decision = decideRecordingAction(null, null, "/tmp/not-a-session");

    expect(decision.action).toBe("skip");
    expect(decision.warning).toContain("no taskId, no session correlation key");
    expect(decision.warning).toContain("/tmp/not-a-session");
    expect(decision.warning).toContain("skipping DB write");
    // Nothing to key the write on — there must be no task id to write either.
    expect(decision.effectiveTaskId).toBeUndefined();
  });

  test("session key but unresolved taskId -> record with the sentinel, not a fabricated id", () => {
    // The mt#2315 case. Pre-mt#3019 this dropped the entire write while its
    // own inline comment claimed it would "still record with a placeholder".
    const decision = decideRecordingAction(null, "session-abc", SESSION_CWD);

    expect(decision.action).toBe("record");
    expect(decision.effectiveTaskId).toBe(UNKNOWN_TASK_ID);
    expect(decision.warning).toContain("could not resolve taskId");
    expect(decision.warning).toContain("session-abc");
    expect(decision.warning).toContain("unknown-task sentinel");
  });

  test("taskId but no session key -> record under the real task id, no warning", () => {
    // A null correlation key is passed through as null by the caller; the
    // decision must never invent a substitute string for it.
    const decision = decideRecordingAction("mt#3019", null, "/some/other/dir");

    expect(decision.action).toBe("record");
    expect(decision.effectiveTaskId).toBe("mt#3019");
    expect(decision.warning).toBeUndefined();
  });

  test("both resolved -> record under the real task id, no warning", () => {
    const decision = decideRecordingAction("mt#3019", "session-abc", SESSION_CWD);

    expect(decision.action).toBe("record");
    expect(decision.effectiveTaskId).toBe("mt#3019");
    expect(decision.warning).toBeUndefined();
  });

  test("a real task id is never replaced by the sentinel", () => {
    // Guards the inverse of the mt#3019 fix: the sentinel is for UNRESOLVED
    // ids only. If this ever returned the sentinel for a known task, the
    // tracker would silently stop updating task_id for every dispatch.
    for (const id of ["mt#1", "mt#3019", "md#416", "gh#491"]) {
      expect(decideRecordingAction(id, "session-abc", SESSION_CWD).effectiveTaskId).toBe(id);
    }
  });
});

// ---------------------------------------------------------------------------
// recordFailureBestEffort (mt#3089)
//
// The durable-error-recording fallback for when classifyAndRecord throws.
// These tests cover its no-op guards, which are pure/synchronous-fast enough
// to assert without needing a live DB — the function must return WITHOUT
// attempting any persistence-provider import in either guarded case.
// ---------------------------------------------------------------------------

describe("recordFailureBestEffort (mt#3089)", () => {
  test("no-ops when there is no correlation key (subagentSessionId null)", async () => {
    // Should resolve immediately without throwing and without needing a DB —
    // if this reached the persistence import it would still resolve (best-
    // effort), but the point of this guard is to skip that work entirely
    // when there's nothing to correlate the error to.
    await expect(
      recordFailureBestEffort(null, HOOK_UNKNOWN_TASK_ID, "some error")
    ).resolves.toBeUndefined();
  });

  test("no-ops when the entrypoint's deadline has already fired", async () => {
    __setDeadlineExceededForTest(true);
    try {
      await expect(
        recordFailureBestEffort("some-session-id", HOOK_UNKNOWN_TASK_ID, "some error")
      ).resolves.toBeUndefined();
    } finally {
      __setDeadlineExceededForTest(false);
    }
  });

  test("never throws even when given a pathological error message", async () => {
    __setDeadlineExceededForTest(true); // forces the fast no-op path in this env
    try {
      await expect(
        recordFailureBestEffort("some-session-id", HOOK_UNKNOWN_TASK_ID, "x".repeat(10_000))
      ).resolves.toBeUndefined();
    } finally {
      __setDeadlineExceededForTest(false);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end process behavior (PR #2178 R1 BLOCKING #3)
//
// Spawns the hook the way the harness does — a bare `bun <file>` process with a
// JSON payload on stdin — and asserts the fail-safe contract holds. This is the
// shape of check mt#3046 generalizes across every DB-touching hook.
// ---------------------------------------------------------------------------

describe("record-subagent-invocation process contract (mt#3019)", () => {
  const HOOK = new URL("./record-subagent-invocation.ts", import.meta.url).pathname;

  async function runHook(payload: Record<string, unknown>): Promise<{
    exitCode: number;
    stderr: string;
  }> {
    const proc = Bun.spawn(["bun", HOOK], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stderr };
  }

  test("cwd lacking a /sessions/<id> segment -> skips the write and exits 0", async () => {
    const { exitCode, stderr } = await runHook({
      agent_id: "test-agent-no-key",
      cwd: "/tmp/definitely-not-a-session-dir",
      transcript_path: "",
    });

    // The fail-safe contract holds in EVERY environment.
    expect(exitCode).toBe(0);

    // Two legitimate outcomes, depending on whether this environment can reach
    // a database: it either gets far enough to skip on the missing correlation
    // key, or it reports a bootstrap failure as a value. CI has no Postgres
    // configured and takes the second path; a developer machine takes the
    // first. (An earlier revision asserted only the first and failed in CI.)
    // Matched on the stable prefix rather than the full sentence: mt#2292 added
    // the dispatch stamp as a third correlation key, which extended this warning
    // ("...and no dispatch stamp"). Pinning the whole string made a test that
    // asserts a BEHAVIOR fail on a wording change.
    const skippedOnKey = stderr.includes("no taskId, no session correlation key");
    const reportedBootstrapFailure = stderr.includes("domain bootstrap failed");
    expect(skippedOnKey || reportedBootstrapFailure).toBe(true);

    // Environment-independent regression guard: the pre-mt#3019 failure was an
    // UNCAUGHT throw from the domain import, which the entrypoint reports as an
    // "unexpected top-level error". A missing bootstrap resurfaces exactly
    // there, whatever the environment.
    expect(stderr).not.toContain("unexpected top-level error");
    expect(stderr).not.toContain("reflect polyfill");
  }, 30_000);

  test("a STAMPED dispatch reaches the record branch without a TDZ throw", async () => {
    // The mt#3893 regression, at the process level — the only level where it
    // exists. `import.meta.main` is false under `bun test`, so no import of the
    // module can execute the entrypoint whose top-level `await` created the
    // temporal dead zone.
    //
    // The case above cannot catch it: its cwd resolves no correlation key, so
    // `decideRecordingAction` takes the SKIP branch, which never reads
    // `HOOK_UNKNOWN_TASK_ID`. A stamp is what routes execution into the RECORD
    // branch that does — which is exactly why the defect stayed latent until
    // mt#2292 introduced stamps.
    //
    // HONEST LIMIT, stated because a reader will otherwise over-trust this: on a
    // machine that cannot reach Postgres, `recordInvocation` returns early at
    // `ensureHookDomainBootstrap()` and never reaches the branch at all — the
    // assertion then passes vacuously. That is the same environment-dependence
    // the sibling test above documents, and it is why the load-bearing check is
    // the STATIC one in `record-subagent-invocation-entrypoint.test.ts`, which
    // holds everywhere. This test adds real coverage on a developer machine and
    // costs nothing on CI; it is a complement, not the guarantee.
    const root = mkdtempSync(join(tmpdir(), "record-subagent-invocation-stamp-"));
    fixtureRoots.push(root);
    const childTranscript = join(root, "agent-mt3893.jsonl");
    writeFileSync(
      childTranscript,
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `do the thing\n\n${buildDispatchStamp({
            parentAgentSessionId: "mt3893-parent-session",
            parentToolUseId: "toolu_01Mt3893ProcessTest",
          })}`,
        },
      })}\n`
    );

    const { exitCode, stderr } = await runHook({
      agent_id: "mt3893-process-test-agent",
      // The main repo, not a session dir — the raw-dispatch shape, where both
      // pre-mt#2292 keys resolve null and only the stamp survives.
      cwd: process.cwd(),
      transcript_path: "",
      agent_transcript_path: childTranscript,
    });

    expect(exitCode).toBe(0);

    // The specific throw, named. A TDZ ReferenceError surfaces through the
    // entrypoint's catch as an "unexpected top-level error", so both assertions
    // guard it — the second is the precise one.
    expect(stderr).not.toContain("unexpected top-level error");
    expect(stderr).not.toContain("before initialization");
  }, 30_000);

  test("missing agent_id (a main-agent Stop) exits 0 without touching the DB", async () => {
    const { exitCode, stderr } = await runHook({ cwd: "/tmp", transcript_path: "" });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  }, 30_000);

  test("malformed payload still exits 0 — the hook never blocks a subagent stop", async () => {
    const proc = Bun.spawn(["bun", HOOK], {
      stdin: new TextEncoder().encode("not json at all"),
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// resolveMetricsTranscriptPath
// ---------------------------------------------------------------------------

describe("resolveMetricsTranscriptPath", () => {
  test("prefers the per-agent file when it exists on disk", () => {
    const { parentPath, agentPath } = buildTranscriptTree(
      [metricsLine({ toolUseCount: 1 })],
      "abc123",
      [metricsLine({ toolUseCount: 3 })]
    );
    expect(resolveMetricsTranscriptPath(parentPath, "abc123")).toBe(agentPath);
  });

  test("falls back to the given path when no per-agent file exists on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "record-subagent-invocation-"));
    fixtureRoots.push(root);
    const parentPath = join(root, "no-subagents-session.jsonl");
    writeFileSync(parentPath, toJsonl([metricsLine({ toolUseCount: 1 })]));
    expect(resolveMetricsTranscriptPath(parentPath, "zzz999")).toBe(parentPath);
  });

  test("undefined transcriptPath passes through unchanged", () => {
    expect(resolveMetricsTranscriptPath(undefined, "abc123")).toBeUndefined();
  });

  test("already given the per-agent path -> returns it unchanged", () => {
    const { agentPath } = buildTranscriptTree([metricsLine({ toolUseCount: 1 })], "abc123", [
      metricsLine({ toolUseCount: 3 }),
    ]);
    expect(resolveMetricsTranscriptPath(agentPath, "abc123")).toBe(agentPath);
  });
});

// ---------------------------------------------------------------------------
// readTranscriptMetrics on the resolved path (mt#2649 acceptance test)
// ---------------------------------------------------------------------------

describe("readTranscriptMetrics on the resolved path (mt#2649 acceptance test)", () => {
  test("metrics come from the per-agent file, not the parent", async () => {
    // Parent transcript deliberately has DIFFERENT counts/tokens than the
    // per-agent file, so a regression (reading the parent) produces a
    // visibly different — and wrong — result.
    const { parentPath } = buildTranscriptTree(
      [metricsLine({ toolUseCount: 1, inputTokens: 10, outputTokens: 5 })],
      "abc123",
      [
        metricsLine({
          toolUseCount: 2,
          inputTokens: 100,
          outputTokens: 50,
          timestamp: "2026-07-07T00:00:00.000Z",
          agentId: "abc123",
        }),
        metricsLine({ toolUseCount: 1, timestamp: "2026-07-07T00:01:00.000Z", agentId: "abc123" }),
      ]
    );

    const resolved = resolveMetricsTranscriptPath(parentPath, "abc123");
    const metrics = await readTranscriptMetrics(resolved, "abc123");

    expect(metrics.toolUseCount).toBe(3); // 2 + 1 tool_use blocks from the per-agent file
    expect(metrics.totalTokens).toBe(150); // 100 + 50 from the per-agent file
    expect(metrics.durationMs).toBe(60000); // 1 minute between the per-agent timestamps

    // Sanity check: reading the PARENT directly does NOT yield the per-agent
    // numbers — proving the fixtures are distinguishable and the resolved path
    // above is not accidentally reading the parent.
    //
    // mt#3256 changed WHAT the parent read returns: it used to return the
    // parent's own counts (toolUseCount 1, totalTokens 15), because a line
    // carrying no agent id was attributed to whoever was asked about. It now
    // returns all-null, because those lines are attributable to no one. Both
    // are "different from the per-agent numbers"; null is the honest one.
    const parentMetrics = await readTranscriptMetrics(parentPath, "abc123");
    expect(parentMetrics.toolUseCount).toBeNull();
    expect(parentMetrics.totalTokens).toBeNull();
  });

  test("agent_session_id line-filter is preserved on the resolved file", async () => {
    const { parentPath } = buildTranscriptTree([metricsLine({ toolUseCount: 1 })], "abc123", [
      metricsLine({ toolUseCount: 2, agentSessionId: "abc123" }),
      metricsLine({ toolUseCount: 5, agentSessionId: "some-other-agent" }), // filtered out
    ]);

    const resolved = resolveMetricsTranscriptPath(parentPath, "abc123");
    const metrics = await readTranscriptMetrics(resolved, "abc123");

    expect(metrics.toolUseCount).toBe(2);
  });

  test("nulls, not per-agent counts, when the per-agent file truly has no data", async () => {
    const { parentPath } = buildTranscriptTree(
      [metricsLine({ toolUseCount: 1, inputTokens: 10, outputTokens: 5 })],
      "abc123",
      []
    );

    const resolved = resolveMetricsTranscriptPath(parentPath, "abc123");
    const metrics = await readTranscriptMetrics(resolved, "abc123");

    expect(metrics.toolUseCount).toBeNull();
    expect(metrics.totalTokens).toBeNull();
    expect(metrics.durationMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mt#3256 SC2 — an unattributable read must SAY so, not just record null
// ---------------------------------------------------------------------------

describe("attribution-failure warning (mt#3256 SC2)", () => {
  test("usedPerAgentTranscript distinguishes the per-agent file from a parent fallback", () => {
    const { parentPath, agentPath } = buildTranscriptTree(
      [metricsLine({ toolUseCount: 1 })],
      "abc123",
      [metricsLine({ toolUseCount: 1, agentId: "abc123" })]
    );

    expect(usedPerAgentTranscript(agentPath, "abc123")).toBe(true);
    expect(usedPerAgentTranscript(parentPath, "abc123")).toBe(false);
    expect(usedPerAgentTranscript(undefined, "abc123")).toBe(false);
    // A per-agent file belonging to a DIFFERENT agent is not this agent's.
    expect(usedPerAgentTranscript(agentPath, "zzz999")).toBe(false);
  });

  test("the parent-fallback warning names the path and the cause", () => {
    const warning = buildUnattributedModelWarning("abc123", "/tmp/parent.jsonl", false);

    expect(warning).toContain("abc123");
    expect(warning).toContain("/tmp/parent.jsonl");
    expect(warning).toContain("PARENT-transcript fallback");
    // The point of the line: why null was recorded instead of a model.
    expect(warning).toContain("Recording null rather than another agent's model");
    expect(warning.endsWith("\n")).toBe(true);
  });

  test("the per-agent warning distinguishes itself from the fallback case", () => {
    const warning = buildUnattributedModelWarning("abc123", "/tmp/agent-abc123.jsonl", true);

    expect(warning).toContain("its per-agent transcript");
    expect(warning).not.toContain("PARENT-transcript fallback");
  });
});

// ---------------------------------------------------------------------------
// Dispatch-stamp recovery — the close side of the mt#2292 join
// ---------------------------------------------------------------------------

describe("recoverDispatchStamp (mt#2292)", () => {
  const STAMP = {
    parentAgentSessionId: "c4d477ed-06f4-4a8b-884d-e306ec3ac523",
    parentToolUseId: "toolu_01HFmYeonk1aZCcGM9VMt2VD",
  };

  test("recovers the dispatch key from the child's own transcript", () => {
    const read = () =>
      [
        JSON.stringify({ type: "user", content: `work\n\n${buildDispatchStamp(STAMP)}` }),
        JSON.stringify({ type: "assistant", content: "done" }),
      ].join("\n");

    expect(recoverDispatchStamp("/tmp/agent-x.jsonl", read)).toEqual(STAMP);
  });

  test("returns null when no transcript path is supplied", () => {
    // The `undefined` case is a harness build that stops sending the field —
    // the join degrades, it must not throw.
    expect(recoverDispatchStamp(undefined, () => "unused")).toBeNull();
  });

  test("returns null rather than throwing when the transcript is unreadable", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(recoverDispatchStamp("/tmp/missing.jsonl", read)).toBeNull();
  });

  test("returns null for a subagent dispatched before the stamp shipped", () => {
    const read = () => JSON.stringify({ type: "user", content: "plain prompt" });
    expect(recoverDispatchStamp("/tmp/agent-old.jsonl", read)).toBeNull();
  });
});

describe("decideRecordingAction with a dispatch stamp (mt#2292)", () => {
  const STAMP = {
    parentAgentSessionId: "parent-session",
    parentToolUseId: "toolu_dispatch",
  };

  test("a stamp alone makes the raw spawn path recordable", () => {
    // THE regression this task exists to fix. A bare Explore/general-purpose
    // dispatch runs with the MAIN repo as cwd, so both pre-mt#2292 keys resolve
    // null and this used to take the skip branch — which is why ~42% of
    // dispatch rows never closed.
    const decision = decideRecordingAction(null, null, "/Users/x/Projects/minsky", STAMP);

    expect(decision.action).toBe("record");
    expect(decision.effectiveTaskId).toBe(HOOK_UNKNOWN_TASK_ID);
    expect(decision.warning).toContain("toolu_dispatch");
  });

  test("still skips when there is no key of ANY kind", () => {
    const decision = decideRecordingAction(null, null, "/Users/x/Projects/minsky", null);

    expect(decision.action).toBe("skip");
    expect(decision.warning).toContain("no dispatch stamp");
  });

  test("a real task id still wins over the sentinel", () => {
    const decision = decideRecordingAction("mt#2292", null, "/some/cwd", STAMP);

    expect(decision.action).toBe("record");
    expect(decision.effectiveTaskId).toBe("mt#2292");
  });
});

describe("resolveRecordedClassification (mt#3894)", () => {
  const WORKSPACE_CLASSIFICATION = {
    outcome: "committed-no-pr",
    lastCommitHash: "abc123",
    handoffWritten: true,
  } as const;

  test("no workspace: records `no-workspace` and never invokes the classifier", async () => {
    // Both halves matter. The outcome is the fix; the classifier NOT running is what removes a
    // `git` + `gh` subprocess round-trip from a path bounded by an 8s deadline (mt#3893).
    let classifierCalls = 0;
    const classification = await resolveRecordedClassification(null, async () => {
      classifierCalls += 1;
      return WORKSPACE_CLASSIFICATION;
    });

    expect(classifierCalls).toBe(0);
    expect(classification.outcome).toBe("no-workspace");
  });

  test("no workspace: carries no parent-derived columns", async () => {
    // The observed rows held main's HEAD in `last_commit_hash` and `handoff_written = true`
    // read off the operator's own checkout — worse than uninformative, since the commit hash
    // attributes a commit to a subagent that made none.
    const classification = await resolveRecordedClassification(null, async () =>
      Promise.reject(new Error("classifier must not run"))
    );

    expect(classification.lastCommitHash).toBeUndefined();
    expect(classification.prUrl).toBeUndefined();
    expect(classification.handoffWritten).toBe(false);
  });

  test("a session workspace still classifies exactly as before", async () => {
    const classification = await resolveRecordedClassification(
      "79600bf6-f265-47b3-8b2b-6f8fb7ae2db9",
      async () => WORKSPACE_CLASSIFICATION
    );

    expect(classification).toEqual(WORKSPACE_CLASSIFICATION);
  });

  test("the discriminator is the absence of a workspace, not the state of any tree", async () => {
    // AT2: the same no-workspace dispatch classifies identically whichever workspace-derived
    // verdict the classifier would have produced from the cwd it happened to be sitting in.
    const asIfDirty = await resolveRecordedClassification(null, async () => ({
      outcome: "partial-committed-handoff-written" as const,
      lastCommitHash: "deadbeef",
      handoffWritten: true,
    }));
    const asIfClean = await resolveRecordedClassification(null, async () => ({
      outcome: "committed-no-pr" as const,
      lastCommitHash: "deadbeef",
      handoffWritten: false,
    }));

    expect(asIfDirty).toEqual(asIfClean);
    expect(asIfDirty.outcome).toBe("no-workspace");
  });
});
