/**
 * Dispatch watchdog (mt#2646) — detects subagent dispatches whose task is
 * IN-PROGRESS/IN-REVIEW but has gone silent (no commit on the session
 * branch, no related system event — e.g. a PR event, no subagent_invocations
 * progress) for N minutes.
 *
 * Producer/consumer split mirrors `prod-state-cache.ts` (mt#2506):
 *   - PRODUCER (this module): piggybacks the cockpit cadence sweep
 *     (`startDispatchWatchdogSweeper` in sweepers.ts) to periodically compute
 *     the flagged-dispatch set and write it to a local cache file.
 *   - CONSUMER (`.minsky/hooks/inject-dispatch-watchdog.ts`): a
 *     UserPromptSubmit hook that reads ONLY the local cache (cheap, no
 *     network/DB) and injects a warning into the orchestrating conversation
 *     when a dispatch is flagged.
 *
 * Detection logic (`computeDispatchWatchdogFlags`) is a PURE, synchronous
 * function over injected rows / task-status map / activity lookups so it is
 * unit-testable with an injected clock and fake activity sources, with no DB
 * or git subprocess required.
 *
 * Originating incident (mt#2646 spec): during the mt#2607 burndown (~14
 * implementer dispatches, 2026-07-06/07), 5 dispatches ended without a usable
 * completion report — two stalled silently mid-review-convergence for 6.5h,
 * one died with uncommitted work and no handoff, one died on an API error
 * mid-convergence, two stopped cleanly but pre-convergence. Every case
 * required the orchestrator to manually notice the silence.
 *
 * @see mt#2646 — this task
 * @see mt#2506 src/cockpit/prod-state-cache.ts — the producer/consumer template
 * @see mt#1735 packages/domain/src/storage/schemas/subagent-invocations-schema.ts
 * @see mt#2092 packages/domain/src/events/query.ts — the system_events substrate
 */
import * as fs from "fs";
import * as path from "path";
import { getStateDir, atomicWriteJSON } from "./lifecycle";
import { getSessionsDir } from "@minsky/shared/paths";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default "no activity" window before an in-flight dispatch is flagged as
 * stale. Calibrated from the observed mt#2607 burndown cadence: watchdog
 * silence incidents ran for hours before manual detection; 30 minutes gives
 * the orchestrator a much earlier signal than "eventually noticed it's been
 * hours" while staying well above the normal per-tool-call / per-commit
 * cadence of a healthy dispatch (commits land every few minutes during
 * active work). Mirrors the `PROD_STATE_STALENESS_MS` sibling constant in
 * `inject-prod-state.ts` in both value and rationale shape.
 */
export const DISPATCH_WATCHDOG_STALE_MS = 30 * 60 * 1000;

/** Cache filename under the Minsky state dir (consumer hook duplicates this literal — see its header comment). */
export const DISPATCH_WATCHDOG_CACHE_FILENAME = "dispatch-watchdog-cache.json";

/** Absolute path to the dispatch-watchdog cache file. */
export function getDispatchWatchdogCachePath(): string {
  return path.join(getStateDir(), DISPATCH_WATCHDOG_CACHE_FILENAME);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An in-flight (not yet Stop-classified) `subagent_invocations` row. */
export interface InFlightInvocationRow {
  taskId: string;
  subagentSessionId: string | null;
  agentType: string;
  startedAt: string; // ISO-8601
}

/** One flagged (silently stalled) dispatch. */
export interface DispatchWatchdogFlag {
  taskId: string;
  subagentSessionId: string | null;
  agentType: string;
  taskStatus: string;
  startedAt: string; // ISO-8601 — dispatch time
  lastActivityAt: string; // ISO-8601 — the most recent activity signal found
  staleForMs: number;
}

/** The on-disk cache record: the flagged set plus when it was computed. */
export interface DispatchWatchdogSnapshot {
  checkedAt: string; // ISO-8601
  staleMs: number;
  flags: DispatchWatchdogFlag[];
}

/**
 * Synchronous activity-signal lookups consumed by the pure detector.
 * Real callers pre-fetch every value (async) into a map and close over it;
 * tests inject fakes directly.
 */
export interface ActivitySources {
  /** Ms epoch of the last commit on the subagent's session branch, or null if unknown/unavailable. */
  lastCommitAtMs: (subagentSessionId: string | null) => number | null;
  /** Ms epoch of the last related system_events row (PR events, subagent events, etc.), or null. */
  lastEventAtMs: (taskId: string, subagentSessionId: string | null) => number | null;
}

// ---------------------------------------------------------------------------
// Pure detection logic
// ---------------------------------------------------------------------------

/**
 * Compute the set of in-flight dispatches that have gone silent for
 * `staleMs`, restricted to tasks currently IN-PROGRESS or IN-REVIEW.
 *
 * "Activity" for a row is the MAX of: its dispatch `startedAt`, the last
 * commit on its session branch, and the last related system event. A row
 * with no activity signal beyond its own `startedAt` is treated as flaggable
 * once `nowMs - startedAt >= staleMs` — dispatch time is always a valid
 * (if pessimistic) baseline.
 *
 * Pure and synchronous: no I/O. Unit-testable with an injected clock and
 * fake `ActivitySources`.
 */
export function computeDispatchWatchdogFlags(
  rows: InFlightInvocationRow[],
  taskStatuses: Record<string, string | null | undefined>,
  activity: ActivitySources,
  nowMs: number,
  staleMs: number = DISPATCH_WATCHDOG_STALE_MS
): DispatchWatchdogFlag[] {
  const flags: DispatchWatchdogFlag[] = [];

  for (const row of rows) {
    const status = taskStatuses[row.taskId];
    if (status !== "IN-PROGRESS" && status !== "IN-REVIEW") continue;

    const startedMs = Date.parse(row.startedAt);
    if (Number.isNaN(startedMs)) continue; // malformed row — skip rather than mis-flag

    const commitMs = activity.lastCommitAtMs(row.subagentSessionId);
    const eventMs = activity.lastEventAtMs(row.taskId, row.subagentSessionId);

    const candidates = [startedMs, commitMs, eventMs].filter(
      (v): v is number => v !== null && v !== undefined && Number.isFinite(v)
    );
    const lastActivityMs = Math.max(...candidates);
    const staleForMs = nowMs - lastActivityMs;

    if (staleForMs >= staleMs) {
      flags.push({
        taskId: row.taskId,
        subagentSessionId: row.subagentSessionId,
        agentType: row.agentType,
        taskStatus: status,
        startedAt: row.startedAt,
        lastActivityAt: new Date(lastActivityMs).toISOString(),
        staleForMs,
      });
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Producer — real dependency wiring + snapshot builder
// ---------------------------------------------------------------------------

/** Injectable dependencies for {@link buildDispatchWatchdogSnapshot}. */
export interface DispatchWatchdogDeps {
  /** List all `subagent_invocations` rows with `endedAt IS NULL` (dispatched, not yet Stop-classified). */
  listInFlightInvocations: () => Promise<InFlightInvocationRow[]>;
  /** Look up a task's current status (e.g. via TaskService). Returns null/undefined if unknown. */
  getTaskStatus: (taskId: string) => Promise<string | null | undefined>;
  /** Ms epoch of the last commit on a subagent session's branch, or null if unavailable (workspace missing, git error). */
  getLastCommitAtMs: (subagentSessionId: string | null) => Promise<number | null>;
  /** Ms epoch of the last system_events row related to this task/session, or null. */
  getLastEventAtMs: (taskId: string, subagentSessionId: string | null) => Promise<number | null>;
}

/**
 * Build a dispatch-watchdog snapshot from live dependencies: fetches
 * in-flight rows, resolves each row's task status + activity signals
 * (de-duplicated per distinct key so repeated rows for the same
 * task/session don't re-query), then delegates to the pure detector.
 */
export async function buildDispatchWatchdogSnapshot(
  deps: DispatchWatchdogDeps,
  nowMs: number = Date.now(),
  staleMs: number = DISPATCH_WATCHDOG_STALE_MS
): Promise<DispatchWatchdogSnapshot> {
  const rows = await deps.listInFlightInvocations();

  const taskStatuses: Record<string, string | null | undefined> = {};
  const commitAt: Record<string, number | null> = {};
  const eventAt: Record<string, number | null> = {};

  for (const row of rows) {
    if (!(row.taskId in taskStatuses)) {
      taskStatuses[row.taskId] = await deps.getTaskStatus(row.taskId);
    }
    const sidKey = row.subagentSessionId ?? "";
    if (!(sidKey in commitAt)) {
      commitAt[sidKey] = await deps.getLastCommitAtMs(row.subagentSessionId);
    }
    const evKey = `${row.taskId}::${sidKey}`;
    if (!(evKey in eventAt)) {
      eventAt[evKey] = await deps.getLastEventAtMs(row.taskId, row.subagentSessionId);
    }
  }

  const flags = computeDispatchWatchdogFlags(
    rows,
    taskStatuses,
    {
      lastCommitAtMs: (sid) => commitAt[sid ?? ""] ?? null,
      lastEventAtMs: (taskId, sid) => eventAt[`${taskId}::${sid ?? ""}`] ?? null,
    },
    nowMs,
    staleMs
  );

  return { checkedAt: new Date(nowMs).toISOString(), staleMs, flags };
}

/**
 * Resolve the last-commit timestamp for a subagent session's git branch by
 * shelling `git log -1 --format=%ct` in its on-disk workspace. Fails open
 * (returns null) when the session directory doesn't exist (already cleaned
 * up) or the git call fails — this is a best-effort activity signal, not a
 * hard dependency.
 */
export async function getSessionLastCommitAtMs(
  subagentSessionId: string | null
): Promise<number | null> {
  if (!subagentSessionId) return null;
  const sessionDir = path.join(getSessionsDir(), subagentSessionId);
  try {
    if (!fs.existsSync(sessionDir)) return null;
    const proc = Bun.spawn(["git", "log", "-1", "--format=%ct"], {
      cwd: sessionDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    const epochSeconds = Number.parseInt(output.trim(), 10);
    if (!Number.isFinite(epochSeconds)) return null;
    return epochSeconds * 1000;
  } catch {
    return null;
  }
}

/** Write a snapshot to the cache file (atomic temp+rename via the shared lifecycle helper). */
export function writeDispatchWatchdogCache(
  snapshot: DispatchWatchdogSnapshot,
  cachePath: string = getDispatchWatchdogCachePath()
): boolean {
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteJSON(cachePath, snapshot);
    return true;
  } catch (err) {
    log.warn("dispatch-watchdog: failed to write cache", {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Build the real dependency set from the cockpit's persistence/task-service
 * singletons plus the git/session-workspace activity signal. Returns null
 * when the DB is unavailable (non-SQL provider) so the sweeper tick can
 * skip cleanly.
 */
export async function buildRealDispatchWatchdogDeps(): Promise<DispatchWatchdogDeps | null> {
  const { getServerTaskService } = await import("./db-providers");
  const { getSharedPersistenceService } = await import("./shared-persistence");

  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();
  const getRawSql =
    "getRawSqlConnection" in provider &&
    typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function"
      ? (provider as { getRawSqlConnection: () => Promise<unknown> }).getRawSqlConnection.bind(
          provider
        )
      : null;
  if (!getRawSql) return null;

  const sql = (await getRawSql()) as
    | { unsafe: (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>> }
    | null
    | undefined;
  if (!sql) return null;

  const taskService = await getServerTaskService();

  return {
    listInFlightInvocations: async () => {
      const rows = (await sql.unsafe(
        `SELECT task_id, subagent_session_id, agent_type, started_at
         FROM subagent_invocations
         WHERE ended_at IS NULL`
      )) as Array<{
        task_id: string;
        subagent_session_id: string | null;
        agent_type: string;
        started_at: string | Date;
      }>;
      return rows.map((r) => ({
        taskId: r.task_id,
        subagentSessionId: r.subagent_session_id,
        agentType: r.agent_type,
        startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
      }));
    },
    getTaskStatus: async (taskId: string) => {
      if (!taskService) return null;
      try {
        return (await taskService.getTaskStatus(taskId)) ?? null;
      } catch {
        return null;
      }
    },
    getLastCommitAtMs: getSessionLastCommitAtMs,
    getLastEventAtMs: async (taskId, subagentSessionId) => {
      const rows = (await sql.unsafe(
        `SELECT max(created_at)::bigint AS latest_at
         FROM system_events
         WHERE related_task_id = $1 OR ($2::text IS NOT NULL AND related_session_id = $2)`,
        [taskId, subagentSessionId]
      )) as Array<{ latest_at: string | number | null }>;
      const raw = rows?.[0]?.latest_at;
      if (raw === null || raw === undefined) return null;
      const ms = Number(raw);
      return Number.isFinite(ms) ? ms : null;
    },
  };
}

/**
 * Refresh the dispatch-watchdog cache once. Fail-open: any error logs and
 * returns false, leaving the last-good cache in place — matches
 * `refreshProdStateCache`'s contract.
 */
export async function refreshDispatchWatchdogCache(
  nowMs: number = Date.now(),
  staleMs: number = DISPATCH_WATCHDOG_STALE_MS,
  cachePath?: string
): Promise<boolean> {
  try {
    const deps = await buildRealDispatchWatchdogDeps();
    if (!deps) {
      log.debug("dispatch-watchdog: no SQL-capable DB, skipping refresh");
      return false;
    }
    const snapshot = await buildDispatchWatchdogSnapshot(deps, nowMs, staleMs);
    return writeDispatchWatchdogCache(snapshot, cachePath);
  } catch (err) {
    log.warn("dispatch-watchdog: refresh failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
