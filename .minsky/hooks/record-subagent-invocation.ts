#!/usr/bin/env bun
// SubagentStop hook: record completed subagent invocation to the DB.
//
// Fires when a subagent stops (successfully or with an error). Classifies
// the subagent's workspace outcome and records the invocation via
// SubagentDispatchTracker.recordSubagentInvocation().
//
// Fail-safe contract: any error logs a warning to stderr and exits 0.
// This hook must NEVER block a subagent stop event.
//
// @see mt#1737 — this file
// @see src/mcp/subagent-dispatch-tracker.ts — DB write layer
// @see src/domain/subagent/workspace-classifier.ts — workspace state
// @see src/domain/subagent/transcript-metrics.ts — transcript metrics
// @see mt#2649 — metrics read the wrong file for background-dispatched subagents
// @see .claude/hooks/transcript.ts — resolveTranscriptCandidates (mt#2637 / PR #1806)
// @see mt#2796 — actual_model writer (extractActualModel, transcript-metrics.ts)
// @see mt#3019 — domain bootstrap (this hook's DB path had never executed), the
//      unresolved-taskId fix (subsumed mt#2315), and the fail-safe deadline

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readInput } from "./types";
import type { StopHookInput } from "./types";
import { resolveTranscriptCandidates } from "./transcript";
import { safeTruncate } from "@minsky/shared/safe-truncate";
// mt#3019: STATIC — importing this module installs the tsyringe reflect
// polyfill, which must be resolved before ANY domain module loads. Every
// domain import below stays dynamic; this one cannot be.
import { ensureHookDomainBootstrap } from "./domain-bootstrap";

/**
 * Overall deadline for the whole Stop-time recording path (mt#3019).
 *
 * The fail-safe contract above says this hook must never block a subagent stop.
 * Until mt#3019 that was true by accident: the DB path died at its first domain
 * import, so nothing could hang. With the path live, a slow or unreachable
 * Postgres becomes a real hang risk against the harness's host cap. The
 * mt#2982 connect timeout (2s, applied in `ensureHookDomainBootstrap`) bounds
 * the connect specifically; this deadline is the backstop for the
 * slow-but-not-hanging tail — same role, and same 8s value, as
 * `STANDALONE_DUP_PROBE_TIMEOUT_MS` in standalone-dup-probe.ts (mt#2958).
 */
export const RECORD_INVOCATION_TIMEOUT_MS = 8_000;

/** Bound on the post-deadline `provider.close()` so cleanup cannot itself hang the exit. */
const CLEANUP_GRACE_MS = 1_000;

const TIMED_OUT = Symbol("record-subagent-invocation-timeout");

/**
 * Cooperative-cancellation state shared between the entrypoint's deadline and
 * the in-flight `recordInvocation` (PR #2178 R1 BLOCKING #1).
 *
 * `Promise.race` does NOT cancel the losing promise, so on a timeout the
 * recording path would otherwise keep running — and `process.exit(0)` would
 * terminate it mid-flight, skipping its `finally` cleanup and potentially
 * killing a connection with a write in progress. Two mechanisms close that:
 *
 *   - `exceeded` is checked at each phase boundary (before opening the DB
 *     connection, and again immediately before the write), so the path bails
 *     out rather than starting work it cannot finish.
 *   - `provider` is registered as soon as one is resolved, so the entrypoint
 *     can close it on the timeout path — the cleanup that the abandoned
 *     `finally` would otherwise never run.
 *
 * A write already issued when the deadline fires is still abandoned; that
 * single statement's transaction is rolled back server-side when the
 * connection drops. The guarantee here is that no NEW write is issued after
 * the deadline and no connection is leaked.
 */
interface DeadlineState {
  exceeded: boolean;
  provider: { close(): Promise<void> } | null;
}

const deadlineState: DeadlineState = { exceeded: false, provider: null };

/**
 * Test-only: force (or clear) the deadline-exceeded flag so tests can
 * exercise `recordFailureBestEffort`'s "no new work after deadline" guard
 * (mt#3089) without needing to actually wait out `RECORD_INVOCATION_TIMEOUT_MS`.
 */
export function __setDeadlineExceededForTest(value: boolean): void {
  deadlineState.exceeded = value;
}

/** Close the registered provider, bounded so cleanup cannot hang the exit. */
async function closeRegisteredProvider(): Promise<void> {
  const provider = deadlineState.provider;
  deadlineState.provider = null;
  if (!provider) return;
  try {
    await Promise.race([
      provider.close(),
      new Promise<void>((resolve) => setTimeout(resolve, CLEANUP_GRACE_MS)),
    ]);
  } catch {
    /* cleanup is best-effort — never block the stop event */
  }
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Inside the try (PR #2178 R1): `readInput` is `Bun.stdin.json()`, which
    // THROWS on a malformed payload. Reading it outside the guard meant a
    // truncated or non-JSON stdin exited the process non-zero — a direct
    // violation of the fail-safe contract above, since a non-zero hook exit is
    // exactly what blocks the event it observes. Surfaced by this file's
    // "malformed payload still exits 0" test.
    const input = await readInput<StopHookInput>();

    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        deadlineState.exceeded = true;
        resolve(TIMED_OUT);
      }, RECORD_INVOCATION_TIMEOUT_MS);
    });
    const outcome = await Promise.race([recordInvocation(input), deadline]);
    if (outcome === TIMED_OUT) {
      process.stderr.write(
        `[record-subagent-invocation] warn: exceeded the ${RECORD_INVOCATION_TIMEOUT_MS}ms deadline — invocation not recorded\n`
      );
      // The abandoned path's `finally` will never run before process.exit —
      // close its provider here instead of leaking the connection.
      await closeRegisteredProvider();
    }
  } catch (err) {
    process.stderr.write(
      `[record-subagent-invocation] warn: unexpected top-level error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    await closeRegisteredProvider();
  } finally {
    clearTimeout(timer);
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Metrics-transcript resolution (mt#2649)
// ---------------------------------------------------------------------------

/**
 * Resolve the transcript file to read metrics from for a given subagent.
 *
 * Background-Agent-dispatched subagents receive a `transcript_path` pointing
 * at the PARENT session's top-level transcript (`<session-id>.jsonl`), while
 * the subagent's own tool_use/usage lines live at
 * `<session-dir>/subagents/agent-<agentId>.jsonl` (mt#2637 diagnosis). Passing
 * the parent path straight to `readTranscriptMetrics` reads the wrong file and
 * yields null/incorrect `toolUseCount` / `totalTokens` / `durationMs`.
 *
 * Reuses {@link resolveTranscriptCandidates} (mt#2637 / PR #1806) to derive the
 * candidate set, then prefers the precise `agent-<agentId>.jsonl` file when it
 * exists on disk. Falls back to the given `transcriptPath` when no such file
 * exists (main-thread invocations, or a harness build where `transcript_path`
 * is already per-agent-correct) — `readTranscriptMetrics` is fail-safe on a
 * missing/unreadable file either way, and the caller still passes `agentId`
 * through so the `agent_session_id` line-filter is preserved on whichever
 * file is ultimately read.
 *
 * Exported for testing.
 */
export function resolveMetricsTranscriptPath(
  transcriptPath: string | undefined,
  agentId: string
): string | undefined {
  if (!transcriptPath) return transcriptPath;
  const perAgentFile = `agent-${agentId}.jsonl`;
  const candidates = resolveTranscriptCandidates(transcriptPath, agentId);
  // Match the directory-qualified per-agent path (R1: stricter than a bare
  // basename match, which could pair with a similarly-named candidate from an
  // adjacent tree if the candidate set ever widens beyond this session).
  const perAgentSuffix = join("subagents", perAgentFile);
  const perAgentPath = candidates.find((candidate) => candidate.endsWith(perAgentSuffix));
  return perAgentPath && existsSync(perAgentPath) ? perAgentPath : transcriptPath;
}

// ---------------------------------------------------------------------------
// Recording decision (PR #2178 R1 BLOCKING #3)
// ---------------------------------------------------------------------------

/**
 * Sentinel written to `task_id` when the real task ID could not be resolved.
 *
 * Duplicated from `src/mcp/subagent-dispatch-tracker.ts`'s `UNKNOWN_TASK_ID`
 * rather than imported, so {@link decideRecordingAction} stays a pure,
 * synchronous, dependency-free function that unit tests can call without
 * loading the domain module tree. `record-subagent-invocation.test.ts` pins
 * the two constants equal, so a change to either side fails a test rather than
 * drifting silently.
 */
export const HOOK_UNKNOWN_TASK_ID = "unknown";

/** What the Stop-time path should do, given what it managed to resolve. */
export type RecordingDecision =
  | { action: "skip"; warning: string; effectiveTaskId?: undefined }
  | { action: "record"; effectiveTaskId: string; warning?: string };

/**
 * Decide whether a Stop event can be recorded, and under which task id.
 *
 * Extracted as a pure function so the branch table is directly testable — the
 * surrounding `recordInvocation` needs a live DB, a real workspace, and a
 * harness payload, which is exactly the coupling that let the pre-mt#3019 bug
 * hide behind green tracker-level mocks.
 *
 * Branches:
 *  - **neither key** — skip. An INSERT would create an orphan row keyed on
 *    nothing and attributed to no task: strictly worse than recording nothing.
 *    This is the ONLY case where dropping the write is correct, and unlike the
 *    pre-mt#3019 code (which dropped whenever the TASK id alone was missing,
 *    contradicting its own inline comment — mt#2315) the comment and the
 *    behavior now agree.
 *  - **session key, no task id** — record with the sentinel. The dispatch-time
 *    row already carries the real task id and `subagentSessionId` is enough to
 *    find it; the tracker's UPDATE path drops the sentinel rather than
 *    clobbering that value.
 *  - **task id, no session key** — record. The write can still land via the
 *    marker's strong binding, or insert an attributable orphan row. A null
 *    correlation key is passed through as null, never as a fabricated string.
 *  - **both** — record normally.
 */
export function decideRecordingAction(
  taskId: string | null,
  subagentSessionId: string | null,
  cwd: string | undefined
): RecordingDecision {
  if (!taskId && !subagentSessionId) {
    return {
      action: "skip",
      warning: `[record-subagent-invocation] warn: no taskId and no session correlation key for cwd=${cwd} — skipping DB write\n`,
    };
  }

  if (!taskId) {
    return {
      action: "record",
      effectiveTaskId: HOOK_UNKNOWN_TASK_ID,
      warning: `[record-subagent-invocation] warn: could not resolve taskId for cwd=${cwd} — recording against session ${subagentSessionId} with the unknown-task sentinel\n`,
    };
  }

  return { action: "record", effectiveTaskId: taskId };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function recordInvocation(input: StopHookInput): Promise<void> {
  const agentId = input.agent_id;
  const cwd = input.cwd;
  const transcriptPath = input.transcript_path;

  if (!agentId) {
    // No agent_id means this is the main agent's Stop, not a SubagentStop.
    // The hook is registered under SubagentStop, so this shouldn't happen,
    // but guard defensively.
    return;
  }

  // 0. Bootstrap the domain layer (mt#3019). A hook is its own entry point:
  //    nothing else in this process installs the tsyringe reflect polyfill or
  //    initializes the process-global configuration system, and EVERY domain
  //    import below fails without them. This must precede the first such
  //    import — including `resolveTaskId`'s.
  const bootstrap = await ensureHookDomainBootstrap();
  if (!bootstrap.ok) {
    process.stderr.write(
      `[record-subagent-invocation] warn: domain bootstrap failed: ${bootstrap.error}\n`
    );
    return;
  }

  // 1. Derive the upsert correlation key and the task ID.
  //
  //    The correlation key is the SUBAGENT's Minsky session id (NOT the harness
  //    agent_id), encoded in the last segment of the cwd path — dispatch wrote
  //    the pending row keyed on it (PR #1053 R1 BLOCKING #1). It is resolved
  //    FIRST (mt#3019) because it, not the task ID, is what makes a Stop-time
  //    write land on the right row.
  const subagentSessionId = extractMinskySessionId(cwd);

  //    Session directories are named after the session ID, not the task ID, so
  //    the task ID comes from the session record (or the git branch).
  const taskId = await resolveTaskId(cwd);

  const decision = decideRecordingAction(taskId, subagentSessionId, cwd);
  if (decision.warning) process.stderr.write(decision.warning);
  if (decision.action === "skip") return;

  // mt#3089: classification + metrics + the DB write (steps 2-4, extracted to
  // classifyAndRecord below) are wrapped so ANY unexpected throw in that
  // section gets a DURABLE failure signal instead of only the stderr line the
  // entrypoint's outer catch would otherwise reduce it to (stderr vanishes —
  // Claude Code does not retain hook stderr anywhere queryable). This is
  // exactly the gap mt#3089's diagnosis found: an uncaught throw in
  // `classifyWorkspaceOutcome` (workspace-classifier.ts's pre-fix unguarded
  // `Bun.spawnSync(["git", ...])` — ENOENT-throws when a SubagentStop hook
  // process's PATH omits git, the same class mt#2810 fixed elsewhere) meant
  // subagent_invocations.agent_session_id / actual_model were NEVER written
  // by this hook in production, and the failure left no trace anywhere.
  // `recordFailureBestEffort` is the loud, durable replacement — it never
  // throws itself and is a no-op when there's no correlation key to attach
  // the error to.
  try {
    await classifyAndRecord({
      cwd,
      agentId,
      transcriptPath,
      effectiveTaskId: decision.effectiveTaskId,
      subagentSessionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[record-subagent-invocation] warn: recording step failed: ${message}\n`);
    await recordFailureBestEffort(subagentSessionId, decision.effectiveTaskId, message);
  }
}

/**
 * Steps 2-4 of the Stop-time recording path, extracted so `recordInvocation`
 * can wrap the whole section in one try/catch (mt#3089 — see the call site's
 * comment for why). Behavior is unchanged from before the extraction; only
 * the function boundary is new.
 */
async function classifyAndRecord(params: {
  cwd: string;
  agentId: string;
  transcriptPath: string | undefined;
  effectiveTaskId: string;
  subagentSessionId: string | null;
}): Promise<void> {
  const { cwd, agentId, transcriptPath, effectiveTaskId, subagentSessionId } = params;

  // 2. Classify workspace outcome. The classifier uses taskId only to locate a
  //    handoff file and to look up a PR by branch name; with the sentinel both
  //    degrade to "not found" while the commit/handoff classification — the
  //    part that matters — still works.
  const { classifyWorkspaceOutcome } = await import(
    "../../packages/domain/src/subagent/workspace-classifier"
  );
  const { SubagentDispatchTracker, UNKNOWN_AGENT_TYPE } = await import(
    "../../src/mcp/subagent-dispatch-tracker"
  );
  const classification = await classifyWorkspaceOutcome(cwd, effectiveTaskId);

  // 3. Read transcript metrics (best-effort).
  const { readTranscriptMetrics, extractActualModel, readTranscriptLines } = await import(
    "../../packages/domain/src/subagent/transcript-metrics"
  );
  const resolvedTranscriptPath = resolveMetricsTranscriptPath(transcriptPath, agentId);
  // mt#2796 R1 NON-BLOCKING: read the file once and share the parsed lines
  // between readTranscriptMetrics and extractActualModel — both scan the same
  // transcript, and previously each independently re-read it from disk.
  const transcriptLines = resolvedTranscriptPath
    ? (readTranscriptLines(resolvedTranscriptPath) ?? undefined)
    : undefined;
  const metrics = await readTranscriptMetrics(resolvedTranscriptPath, agentId, transcriptLines);

  // mt#2796: extract the first genuine (non-`<synthetic>`) model id from the
  // resolved transcript's assistant-message lines. Best-effort — never throws,
  // returns null when no genuine model id is found.
  const actualModel = extractActualModel(resolvedTranscriptPath, agentId, transcriptLines);

  // 4. Open a DB connection and record the invocation.
  //
  //    Cancellation checkpoint (PR #2178 R1 BLOCKING #1): everything above is
  //    local filesystem/git work. This is the boundary where the expensive,
  //    abandonable work starts, so bail here if the deadline already fired
  //    rather than opening a connection nothing will close.
  if (deadlineState.exceeded) return;

  const { resolvePersistenceProvider } = await import(
    "../../packages/domain/src/persistence/factory"
  );
  const provider = await resolvePersistenceProvider();
  if (!provider || !("getDatabaseConnection" in provider)) {
    process.stderr.write(
      `[record-subagent-invocation] warn: persistence provider unavailable — skipping DB write\n`
    );
    return;
  }

  // Register for post-deadline cleanup: if the entrypoint's deadline wins the
  // race, this function's own `finally` never runs before `process.exit`.
  deadlineState.provider = provider;

  let db: import("drizzle-orm/postgres-js").PostgresJsDatabase | null = null;
  try {
    db = (await (
      provider as {
        getDatabaseConnection(): Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
      }
    ).getDatabaseConnection()) as import("drizzle-orm/postgres-js").PostgresJsDatabase;
  } catch (err) {
    process.stderr.write(
      `[record-subagent-invocation] warn: getDatabaseConnection failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  if (!db) {
    await closeRegisteredProvider();
    return;
  }

  // SubagentDispatchTracker / UNKNOWN_AGENT_TYPE / UNKNOWN_TASK_ID were all
  // imported together at step 2 (the sentinel is needed before the connect).
  const tracker = new SubagentDispatchTracker(db);

  const now = new Date();

  // PR #1053 R1 BLOCKING #1: the upsert correlation key is the SUBAGENT's
  // Minsky session id (NOT the harness agent_id), which is encoded in the
  // last segment of the cwd path. Dispatch wrote the pending row with
  // `subagentSessionId = <subagent's Minsky session id>`; we must use the
  // same key here for the upsert to find that row.
  //
  // The harness agent_id is stored separately as `agentSessionId` (joins
  // `agent_transcripts.agent_session_id` per mt#1313).
  //
  // This hook does NOT know the real dispatch-time `agentType` — it only
  // observes the workspace at Stop time. It always sends the
  // `UNKNOWN_AGENT_TYPE` sentinel below; the tracker's `recordSubagentInvocation`
  // (mt#2653) is responsible for NOT clobbering the real dispatch-time value
  // on the UPDATE path when it sees that sentinel. On the INSERT path (orphan
  // Stop without a matching dispatch row) the sentinel satisfies the schema's
  // NOT NULL constraint on `agent_type`. `UNKNOWN_TASK_ID` above works the
  // same way for `task_id` (mt#3019).
  //
  // mt#2831 R1 BLOCKING #1: strong-binding read. When the current-invocation
  // marker file names an exact row, pass it through as `id` — the tracker's
  // strong-binding path then updates THAT row directly, immune to the
  // late-Stop-event misattribution a subagentSessionId-only lookup can hit once
  // a dispatch has been auto-resumed (see
  // packages/domain/src/session/current-invocation-marker.ts and
  // SubagentDispatchTracker.recordSubagentInvocation's docstring). Absent/
  // unreadable marker (pre-mt#2831 session, or a write that never landed) falls
  // through to `undefined`, and the tracker uses its heuristic fallback —
  // unchanged behavior from before this mechanism existed.
  let markerInvocationId: string | undefined;
  if (subagentSessionId) {
    const { readCurrentInvocationMarker } = await import(
      "../../packages/domain/src/session/current-invocation-marker"
    );
    markerInvocationId = (await readCurrentInvocationMarker(cwd, subagentSessionId)) ?? undefined;
  }

  // Final cancellation checkpoint (PR #2178 R1 BLOCKING #1): never ISSUE a
  // write after the deadline has fired. A write already in flight is abandoned
  // and rolled back server-side when the connection drops; this ensures we
  // don't start a new one the process is about to be exited out from under.
  if (deadlineState.exceeded) {
    await closeRegisteredProvider();
    return;
  }

  await tracker.recordSubagentInvocation({
    id: markerInvocationId,
    taskId: effectiveTaskId,
    subagentSessionId,
    agentSessionId: agentId, // harness-native conversation UUID
    outcome: classification.outcome,
    prUrl: classification.prUrl ?? null,
    lastCommitHash: classification.lastCommitHash ?? null,
    handoffWritten: classification.handoffWritten,
    toolUseCount: metrics.toolUseCount ?? null,
    totalTokens: metrics.totalTokens ?? null,
    durationMs: metrics.durationMs ?? null,
    actualModel: actualModel ?? null,
    endedAt: now,
    startedAt: now, // tracker preserves startedAt on upsert (per mt#1736 R1 fix)
    // agentType is required by SubagentInvocationInput (NOT NULL) but this
    // hook has no way to recover the real dispatch-time value. The tracker's
    // UPDATE path (mt#2653) treats this sentinel as "no real value known" and
    // leaves the dispatch-set value untouched instead of clobbering it.
    agentType: UNKNOWN_AGENT_TYPE,
  });

  await closeRegisteredProvider();
}

/**
 * Best-effort, bounded attempt to persist a durable failure signal when
 * `classifyAndRecord` throws (mt#3089 "make any swallow loud"). Without this,
 * ANY error in that section was caught only by the entrypoint's outer
 * try/catch, which logs to stderr — never persisted anywhere Claude Code
 * retains — and exits 0 per the fail-safe contract, so a SubagentStop write
 * that silently fails is, from the DB's perspective, indistinguishable from
 * one that never fired at all. This writes the error onto the correlated
 * row's `error_summary` column instead, so a future occurrence is diagnosable
 * with a single query rather than the multi-hour forensic reconstruction this
 * task's own diagnosis required (grep every closed row's `summary` field for
 * which write path actually produced it).
 *
 * Uses the tracker's existing heuristic upsert (prefers the most recent OPEN
 * row for `subagentSessionId` — the pending row dispatch wrote) rather than
 * the strong-binding `id` path, since a failure this early may not have
 * reached the current-invocation-marker read.
 *
 * Never throws. No-ops when there is no correlation key to attach the error
 * to, or when the entrypoint's deadline has already fired (respecting the
 * "no new work after deadline" contract the rest of this hook applies).
 */
export async function recordFailureBestEffort(
  subagentSessionId: string | null,
  effectiveTaskId: string,
  errorMessage: string
): Promise<void> {
  if (!subagentSessionId || deadlineState.exceeded) return;
  try {
    const { resolvePersistenceProvider } = await import(
      "../../packages/domain/src/persistence/factory"
    );
    const provider = await resolvePersistenceProvider();
    if (!provider || !("getDatabaseConnection" in provider)) return;

    let db: import("drizzle-orm/postgres-js").PostgresJsDatabase | null = null;
    try {
      db = (await (
        provider as {
          getDatabaseConnection(): Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
        }
      ).getDatabaseConnection()) as import("drizzle-orm/postgres-js").PostgresJsDatabase;
    } catch {
      db = null;
    }
    if (!db) {
      await provider.close().catch(() => {});
      return;
    }

    const { SubagentDispatchTracker, UNKNOWN_AGENT_TYPE } = await import(
      "../../src/mcp/subagent-dispatch-tracker"
    );
    const tracker = new SubagentDispatchTracker(db);
    await tracker.recordSubagentInvocation({
      taskId: effectiveTaskId,
      subagentSessionId,
      agentType: UNKNOWN_AGENT_TYPE,
      outcome: "crashed-no-output",
      errorSummary: safeTruncate(errorMessage, 2000, "head"),
      startedAt: new Date(),
      endedAt: new Date(),
    });
    await provider.close().catch(() => {});
  } catch {
    // Never let the failure-recording path itself fail loudly — it is
    // already a best-effort fallback for an already-failed operation.
  }
}

// ---------------------------------------------------------------------------
// Minsky session id extraction
// ---------------------------------------------------------------------------

/**
 * Extract the subagent's Minsky session id from the cwd path.
 *
 * Session workspaces are stored at `~/.local/state/minsky/sessions/<sessionId>`.
 * The session id is a UUID; we take the last non-empty path segment.
 *
 * Used as the upsert correlation key by `recordSubagentInvocation` — both
 * dispatch-time and SubagentStop-time writes resolve to the same session id
 * so the upsert finds the pending row.
 *
 * Returns null if the cwd doesn't have an extractable session id (e.g.,
 * empty, no sessions/ segment).
 */
function extractMinskySessionId(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const match = cwd.match(/\/sessions\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Task ID resolution
// ---------------------------------------------------------------------------

/**
 * Derive a task ID from the subagent's cwd.
 *
 * Strategy:
 *   1. Check if the cwd path contains a session ID segment matching a known
 *      Minsky session. Query the DB to get the task ID for that session.
 *   2. Fall back to extracting the task ID from the cwd basename if it looks
 *      like a task-named directory (e.g., `task/mt-1737`).
 *
 * Returns null when the task ID cannot be determined.
 */
async function resolveTaskId(cwd: string): Promise<string | null> {
  if (!cwd) return null;

  // Strategy 1: Try to load the session record by session directory path.
  // Session workspaces are stored in ~/.local/state/minsky/sessions/<sessionId>.
  try {
    const { resolvePersistenceProvider } = await import(
      "../../packages/domain/src/persistence/factory"
    );
    const provider = await resolvePersistenceProvider();
    if (provider) {
      try {
        const { createSessionProvider } = await import(
          "../../packages/domain/src/session/drizzle-session-repository"
        );
        // eslint-disable-next-line custom/no-singleton-reach-in -- hook bootstrap: the provider is passed via arg (DI), not reached-in
        const sessionProvider = await createSessionProvider(undefined, provider);
        const sessions = await sessionProvider.listSessions();
        for (const rec of sessions) {
          if (typeof rec.taskId === "string") {
            // Check if cwd is under this session's directory
            const sessionId = rec.sessionId ?? "";
            if (sessionId && cwd.includes(sessionId)) {
              // The `finally` below closes the provider — no inner close (would
              // double-close + mask close-time errors; PR #1625 R1 NON-BLOCKING).
              return rec.taskId;
            }
          }
        }
      } finally {
        try {
          await provider.close();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    // Fall through to heuristic
  }

  // Strategy 2: Extract session ID from cwd and match to task via git remote.
  // Minsky session directories follow: ~/.local/state/minsky/sessions/<sessionId>
  // The git remote URL contains the task branch: task/mt-<id>
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      const branch = result.stdout.toString().trim();
      // Branch format: task/mt-1737 or task/mt#1737
      const match = branch.match(/^task\/mt[-#](\d+)$/);
      if (match) {
        return `mt#${match[1]}`;
      }
    }
  } catch {
    // ignore
  }

  return null;
}
