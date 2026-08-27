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
 * mt#3172 update: the staleness computation now ALSO consults presence-claim
 * (session-scoped MCP tool-call) activity — the SAME signal
 * `tasks.dispatch-recover`'s healthy-classification check has consulted
 * since mt#3086, via the shared `resolveLastPresenceActivityAtMs` helper
 * (`@minsky/domain/session/presence-activity`). Before this, a dispatch that
 * was genuinely alive but quiet (reading code, running tests, no commit yet)
 * could be flagged HERE (this injection fires every turn) even though
 * `tasks.dispatch-recover` would immediately classify it `healthy` on
 * `activitySource: "presence"` — costing a protocol-mandated recover
 * round-trip on every flagged turn until the first commit landed. See
 * `computeDispatchWatchdogFlags`'s docstring for the per-signal precedence
 * and the flag's new `activitySource` field.
 *
 * mt#3193 update: two independent false-positive fixes, both verified NOT
 * already covered by mt#3172 (mt#3172 only shared the EXISTING presence
 * signal with this module — it added no new signal and never touched the
 * IN-REVIEW/PR-state question):
 *
 *   1. A new workspace-mtime signal (dirty-file filesystem timestamps, via
 *      the shared `resolveLastWorkspaceMtimeAtMs` helper,
 *      `@minsky/domain/session/workspace-activity`) closes the gap where a
 *      dispatch works entirely through non-MCP harness tools
 *      (`Read`/`Edit`/`Write`/`Glob`/`Grep`) — `presence_claims` only
 *      refreshes on a Minsky-MCP-routed tool call, so such a dispatch
 *      produced neither a commit nor a presence refresh and was flagged
 *      stalled even after mt#3172 (the mt#3193 originating incident: a
 *      `refactorer` dispatch spent 55 minutes splitting a file into nine
 *      modules entirely through non-MCP tools and was flagged at the
 *      32-minute silent mark, triggering a double-dispatch into the
 *      occupied session).
 *   2. A row whose task is IN-REVIEW with a still-open (or draft) PR is now
 *      EXCLUDED from staleness evaluation entirely (never enters `flags`,
 *      regardless of computed staleness) — a completed dispatch correctly
 *      idling while `minsky-reviewer[bot]` reviews its PR has NO reason to
 *      keep committing, so "no commits for a while" there is the DESIRED
 *      state, not a stall signal. Observed: four dispatches flagged
 *      simultaneously in one watchdog run, all IN-REVIEW with an open PR,
 *      all correctly idle.
 *
 * @see mt#2646 — this task
 * @see mt#3086 — presence-claim signal added to tasks.dispatch-recover's staleness check
 * @see mt#3172 — this update (shares mt#3086's presence signal with the watchdog producer)
 * @see mt#3193 — workspace-mtime signal + IN-REVIEW-with-open-PR exclusion
 * @see mt#2506 src/cockpit/prod-state-cache.ts — the producer/consumer template
 * @see mt#1735 packages/domain/src/storage/schemas/subagent-invocations-schema.ts
 * @see mt#2092 packages/domain/src/events/query.ts — the system_events substrate
 */
import { hasRawSqlConnection } from "@minsky/domain/persistence/types";
import * as fs from "fs";
import * as path from "path";
import { getStateDir, atomicWriteJSON } from "./lifecycle";
import { getSessionsDir } from "@minsky/shared/paths";
import { log } from "@minsky/shared/logger";
import { resolveLastPresenceActivityAtMs } from "@minsky/domain/session/presence-activity";
import { resolveLastWorkspaceMtimeAtMs } from "@minsky/domain/session/workspace-activity";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

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

/**
 * Age bound (mt#3062) on the in-flight query/flag surface: a row whose
 * dispatch `startedAt` is older than this cannot be flagged as a stalled
 * in-flight dispatch, regardless of its computed staleness. This closes the
 * gap the mt#3019 writer fix didn't: a row whose Stop event genuinely never
 * fires (process kill, machine sleep, harness crash) stays `ended_at IS
 * NULL` forever, and if its task is later reopened/resumed to
 * IN-PROGRESS/IN-REVIEW it would otherwise re-enter the flag surface and
 * report a multi-week "stall" for a dispatch that concluded (one way or
 * another) long ago.
 *
 * Grounded per `decision-defaults.mdc §Thresholds` rather than picked as a
 * round number: the longest legitimate dispatch duration observed as of
 * 2026-07-24 is ~108 minutes (mt#3125); the watchdog's own stale window
 * (`DISPATCH_WATCHDOG_STALE_MS`) is 30 minutes. 24h sits nearly 13x above
 * the longest observed legitimate run — a wide safety margin against
 * measurement noise or an unusually long future dispatch — and matches the
 * burst-detection window used elsewhere in the corpus
 * (`decision-defaults.mdc §Thresholds`), rather than an arbitrary distinct
 * value.
 */
export const DISPATCH_WATCHDOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

/**
 * Which signal produced a flagged dispatch's `lastActivityAt` (mt#3172,
 * parity with `tasks.dispatch-recover`'s `DispatchActivitySource`
 * `@minsky/domain/session/dispatch-recovery-classifier` — that type has no
 * `"event"` member since the on-demand recover command does not consult
 * `system_events`; this producer does). mt#3193 adds `"workspace-mtime"`,
 * parity with that same classifier's mt#3193 signal. There is no
 * `"in-review-open-pr"` member here — unlike the on-demand command, this
 * producer's IN-REVIEW+open-PR handling is an EXCLUSION (the row never
 * enters `flags` at all, alongside the `sessionExists`/age-bound guards), not
 * an activity signal with a value to report.
 */
export type DispatchWatchdogActivitySource =
  | "dispatch-start"
  | "commit"
  | "event"
  | "presence"
  | "workspace-mtime";

/**
 * Runtime-reflectable enumeration of every `DispatchWatchdogActivitySource`
 * value (PR #2307 R1 non-blocking) — a TS union type has no runtime
 * representation, so the consumer hook
 * (`.minsky/hooks/inject-dispatch-watchdog.ts`) cannot import/diff against
 * `DispatchWatchdogActivitySource` directly (nor should it, per that file's
 * module-graph-isolation convention — see its own header comment). This
 * const array is what a cross-module parity TEST diffs against the hook's
 * own `RECOGNIZED_ACTIVITY_SOURCES` array, so an activitySource added to one
 * side without the other fails a test instead of silently drifting (this
 * exact drift risk is why the hook needed the mt#3193 fix in the first
 * place — it had normalized "workspace-mtime" away to "dispatch-start"
 * before that fix landed).
 */
export const DISPATCH_WATCHDOG_ACTIVITY_SOURCES = [
  "dispatch-start",
  "commit",
  "event",
  "presence",
  "workspace-mtime",
] as const satisfies readonly DispatchWatchdogActivitySource[];

/** One flagged (silently stalled) dispatch. */
export interface DispatchWatchdogFlag {
  taskId: string;
  subagentSessionId: string | null;
  agentType: string;
  taskStatus: string;
  startedAt: string; // ISO-8601 — dispatch time
  lastActivityAt: string; // ISO-8601 — the most recent activity signal found
  staleForMs: number;
  /** Which signal produced `lastActivityAt` — surfaced so a flagged dispatch stays diagnosable (mt#3172). */
  activitySource: DispatchWatchdogActivitySource;
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
  /**
   * Whether the subagent's session workspace still exists on disk (mt#3062).
   * Distinguishes "session gone" (workspace deleted — cleanup after a merge
   * or completion, or an explicit session_delete; the dispatch has already
   * concluded even if its Stop hook never wrote `ended_at`) from "session
   * silent" (workspace still present, but no recent commit — a genuinely
   * worth-flagging condition). Returns `null` when existence can't be
   * determined (e.g. no `subagentSessionId` was recorded on the row) —
   * treated as "unknown", not "gone", so it does NOT suppress the flag.
   * Optional so existing fakes/tests that predate this check keep compiling;
   * omitting it is equivalent to always returning `null` (unknown).
   */
  sessionExists?: (subagentSessionId: string | null) => boolean | null;
  /**
   * Ms epoch of the most recent presence-claim (session-scoped MCP tool-call)
   * activity for the subagent's session, or null if unknown/unavailable
   * (mt#3172 — parity with `tasks.dispatch-recover`'s mt#3086 presence-claim
   * liveness signal; see `resolveLastPresenceActivityAtMs`,
   * `@minsky/domain/session/presence-activity`, for the query both share).
   * Optional so existing fakes/tests that predate this check keep compiling;
   * omitting it is equivalent to always returning `null` (unknown, does not
   * suppress a flag but also does not clear the activity clock).
   */
  lastPresenceActivityAtMs?: (subagentSessionId: string | null) => number | null;
  /**
   * Ms epoch of the freshest dirty-file mtime in the subagent's session git
   * working tree, or null if unknown/unavailable (mt#3193 — closes the
   * non-MCP-harness-tool activity gap `lastPresenceActivityAtMs` alone
   * leaves open; see `resolveLastWorkspaceMtimeAtMs`,
   * `@minsky/domain/session/workspace-activity`). Optional so existing
   * fakes/tests that predate this check keep compiling; omitting it is
   * equivalent to always returning `null` (unknown, does not suppress a
   * flag but also does not clear the activity clock).
   */
  lastWorkspaceMtimeAtMs?: (subagentSessionId: string | null) => number | null;
  /**
   * Whether the row's task has a still-open (or draft) PR (mt#3193). `true`
   * unconditionally suppresses the flag when the task status is IN-REVIEW
   * (see `computeDispatchWatchdogFlags`'s pre-staleness guards) — idling on
   * review is the desired state, not evidence of a stall. `null`/`false`/
   * omitted do NOT suppress (unknown or no-PR is treated the same as every
   * other guard here: absence of positive evidence never suppresses).
   * Optional so existing fakes/tests that predate this check keep compiling.
   */
  hasOpenPr?: (taskId: string, subagentSessionId: string | null) => boolean | null;
}

// ---------------------------------------------------------------------------
// Pure detection logic
// ---------------------------------------------------------------------------

/**
 * Compute the set of in-flight dispatches that have gone silent for
 * `staleMs`, restricted to tasks currently IN-PROGRESS or IN-REVIEW.
 *
 * "Activity" for a row is the MAX of: its dispatch `startedAt`, the last
 * commit on its session branch, the last related system event, (mt#3172)
 * the last presence-claim (session-scoped MCP tool-call) activity for its
 * session — the same signal `tasks.dispatch-recover`'s healthy-classification
 * check has consulted since mt#3086 — and (mt#3193) the last workspace-mtime
 * (dirty-file filesystem timestamp) activity for its session, closing the
 * gap where a dispatch works entirely through non-MCP harness tools and
 * therefore produces neither a commit nor a presence-claim refresh. A row
 * with no activity signal beyond its own `startedAt` is treated as flaggable
 * once `nowMs - startedAt >= staleMs` — dispatch time is always a valid (if
 * pessimistic) baseline. The returned flag's `activitySource` names
 * whichever of the five signals produced the max, checked in this
 * precedence order: dispatch-start -> commit -> event -> presence ->
 * workspace-mtime.
 *
 * **Tie semantics (fixed in review, PR #2294 R1; mt#3193 extends to
 * workspace-mtime):** each candidate replaces the running max only when
 * STRICTLY GREATER than it (`>`, not `>=`) — so on an exact timestamp tie,
 * the running max does NOT advance and the EARLIER-checked signal wins
 * (e.g. a commit and a presence-claim refresh at the identical ms both
 * present: `activitySource` is `"commit"`, not `"presence"`, because
 * presence's check requires strictly exceeding the value commit already
 * set; likewise presence beats a tied workspace-mtime touch). This is not
 * an arbitrary choice — it is the SAME tie behavior `tasks.dispatch-recover`'s
 * `computeDispatchStaleness` (`@minsky/domain/session/dispatch-recovery-classifier`,
 * mt#3086/mt#3193) already has via its own strict `>` checks, which this
 * producer mirrors for parity (mt#3172's entire point, extended by mt#3193).
 * See that function's docstring for the identical note on its version of
 * this same rule.
 *
 * Three additional guards run before the staleness computation and
 * unconditionally suppress a flag regardless of computed staleness:
 *
 * 1. **Age bound** (mt#3062) — a row whose `startedAt` is older than
 *    `maxAgeMs` cannot be flagged. Protects a reopened/resumed task from
 *    re-arming a weeks-old orphan row into a "multi-week stall" report.
 * 2. **Session existence** (mt#3062) — a row whose subagent session
 *    workspace is confirmed gone (not merely silent) cannot be flagged. The
 *    dispatch already concluded one way or another; there is nothing left
 *    to stall.
 * 3. **IN-REVIEW + open PR** (mt#3193) — a row whose task status is
 *    IN-REVIEW AND `activity.hasOpenPr` resolves `true` cannot be flagged,
 *    UNCONDITIONALLY — no staleness computation runs for it at all. A
 *    completed dispatch correctly idling while `minsky-reviewer[bot]`
 *    reviews its PR has no reason to keep committing or making MCP tool
 *    calls; "no recent activity" there is the DESIRED state, not a stall
 *    signal, so this is a pre-computation exclusion rather than another
 *    activity signal fed into the max above (unlike the other guards, it is
 *    scoped to IN-REVIEW specifically — an IN-PROGRESS row with an open PR,
 *    if that combination ever occurs, is NOT exempted, since IN-PROGRESS
 *    dispatches are still expected to be actively working).
 *
 * Pure and synchronous: no I/O. Unit-testable with an injected clock and
 * fake `ActivitySources`.
 */
export function computeDispatchWatchdogFlags(
  rows: InFlightInvocationRow[],
  taskStatuses: Record<string, string | null | undefined>,
  activity: ActivitySources,
  nowMs: number,
  staleMs: number = DISPATCH_WATCHDOG_STALE_MS,
  maxAgeMs: number = DISPATCH_WATCHDOG_MAX_AGE_MS
): DispatchWatchdogFlag[] {
  const flags: DispatchWatchdogFlag[] = [];

  for (const row of rows) {
    const status = taskStatuses[row.taskId];
    if (status !== "IN-PROGRESS" && status !== "IN-REVIEW") continue;

    const startedMs = Date.parse(row.startedAt);
    if (Number.isNaN(startedMs)) continue; // malformed row — skip rather than mis-flag

    // Age bound (mt#3062) — see DISPATCH_WATCHDOG_MAX_AGE_MS for the basis.
    // >= (not >), matching the staleForMs >= staleMs convention below: a row
    // exactly at the bound is treated as too old, not as a borderline pass.
    if (nowMs - startedMs >= maxAgeMs) continue;

    // Session-existence robustness (mt#3062) — a confirmed-gone session
    // workspace means the dispatch already concluded; only a confirmed
    // `false` suppresses (null/undefined = unknown, does not suppress).
    if (activity.sessionExists?.(row.subagentSessionId) === false) continue;

    // IN-REVIEW + open-PR exclusion (mt#3193) — idling on review is the
    // desired state; only a confirmed `true` suppresses (null/undefined =
    // unknown or no PR, does not suppress). See docstring guard #3.
    if (
      status === "IN-REVIEW" &&
      activity.hasOpenPr?.(row.taskId, row.subagentSessionId) === true
    ) {
      continue;
    }

    const commitMs = activity.lastCommitAtMs(row.subagentSessionId);
    const eventMs = activity.lastEventAtMs(row.taskId, row.subagentSessionId);
    const presenceMs = activity.lastPresenceActivityAtMs?.(row.subagentSessionId) ?? null;
    const workspaceMtimeMs = activity.lastWorkspaceMtimeAtMs?.(row.subagentSessionId) ?? null;

    // Progressive max, tracking WHICH signal produced it (mt#3172; mt#3193
    // adds workspace-mtime) — same numeric result as the prior
    // Math.max(...candidates) approach (each candidate only replaces the
    // running max when strictly greater: `>`, not `>=`), but also yields
    // activitySource for the flag below. On an exact timestamp TIE the
    // running max does NOT advance, so the EARLIER-checked signal wins:
    // dispatch-start beats a tied commit, commit beats a tied event, event
    // beats a tied presence, presence beats a tied workspace-mtime. This
    // mirrors tasks.dispatch-recover's computeDispatchStaleness
    // (mt#3086/mt#3193), which uses the same strict `>` pattern — see PR
    // #2294 R1 / this function's docstring for the full rationale.
    let lastActivityMs = startedMs;
    let activitySource: DispatchWatchdogActivitySource = "dispatch-start";

    if (commitMs !== null && commitMs !== undefined && Number.isFinite(commitMs)) {
      if (commitMs > lastActivityMs) {
        lastActivityMs = commitMs;
        activitySource = "commit";
      }
    }
    if (eventMs !== null && eventMs !== undefined && Number.isFinite(eventMs)) {
      if (eventMs > lastActivityMs) {
        lastActivityMs = eventMs;
        activitySource = "event";
      }
    }
    if (presenceMs !== null && presenceMs !== undefined && Number.isFinite(presenceMs)) {
      if (presenceMs > lastActivityMs) {
        lastActivityMs = presenceMs;
        activitySource = "presence";
      }
    }
    if (
      workspaceMtimeMs !== null &&
      workspaceMtimeMs !== undefined &&
      Number.isFinite(workspaceMtimeMs)
    ) {
      if (workspaceMtimeMs > lastActivityMs) {
        lastActivityMs = workspaceMtimeMs;
        activitySource = "workspace-mtime";
      }
    }

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
        activitySource,
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
  /**
   * Whether the subagent's session workspace still exists on disk (mt#3062).
   * `null` when existence can't be determined (e.g. no `subagentSessionId`
   * recorded) — treated as "unknown", never as "gone".
   */
  getSessionExists: (subagentSessionId: string | null) => Promise<boolean | null>;
  /**
   * Ms epoch of the most recent presence-claim (session-scoped MCP tool-call)
   * activity for the subagent's session, or null if unavailable (mt#3172 —
   * shares `tasks.dispatch-recover`'s mt#3086 presence-claim liveness signal
   * via `resolveLastPresenceActivityAtMs`,
   * `@minsky/domain/session/presence-activity`).
   */
  getLastPresenceActivityAtMs: (subagentSessionId: string | null) => Promise<number | null>;
  /**
   * Ms epoch of the freshest dirty-file mtime in the subagent's session git
   * working tree, or null if unavailable (mt#3193 — shares
   * `tasks.dispatch-recover`'s mt#3193 workspace-mtime liveness signal via
   * `resolveLastWorkspaceMtimeAtMs`, `@minsky/domain/session/workspace-activity`).
   */
  getLastWorkspaceMtimeAtMs: (subagentSessionId: string | null) => Promise<number | null>;
  /**
   * Whether the row's task has a still-open (or draft) PR (mt#3193; refined
   * per PR #2307 R1 BLOCKING #2). `null` ONLY when no PR was ever recorded
   * (no `subagentSessionId`, no session record, or `pull_request` is
   * NULL/empty) — genuinely "no evidence." A non-null `pull_request` value
   * is itself positive evidence a PR exists: `true` for `open`/`draft`
   * state, `false` for `closed`/`merged`, and — critically — ALSO `true`
   * (not `null`) when the JSON is unparseable or `state` is missing/
   * unrecognized, because degrading that case to `null` would silently
   * re-enable the exact false positive this gate exists to suppress (a
   * malformed-but-real PR record falling straight back into staleness
   * evaluation). See `parsePullRequestOpenState`.
   */
  getHasOpenPr: (taskId: string, subagentSessionId: string | null) => Promise<boolean | null>;
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
  const existsAt: Record<string, boolean | null> = {};
  const presenceAt: Record<string, number | null> = {};
  const workspaceMtimeAt: Record<string, number | null> = {};
  const hasOpenPrAt: Record<string, boolean | null> = {};

  for (const row of rows) {
    if (!(row.taskId in taskStatuses)) {
      taskStatuses[row.taskId] = await deps.getTaskStatus(row.taskId);
    }
    const sidKey = row.subagentSessionId ?? "";
    if (!(sidKey in commitAt)) {
      commitAt[sidKey] = await deps.getLastCommitAtMs(row.subagentSessionId);
    }
    if (!(sidKey in existsAt)) {
      existsAt[sidKey] = await deps.getSessionExists(row.subagentSessionId);
    }
    if (!(sidKey in presenceAt)) {
      presenceAt[sidKey] = await deps.getLastPresenceActivityAtMs(row.subagentSessionId);
    }
    if (!(sidKey in workspaceMtimeAt)) {
      workspaceMtimeAt[sidKey] = await deps.getLastWorkspaceMtimeAtMs(row.subagentSessionId);
    }
    const evKey = `${row.taskId}::${sidKey}`;
    if (!(evKey in eventAt)) {
      eventAt[evKey] = await deps.getLastEventAtMs(row.taskId, row.subagentSessionId);
    }
    if (!(evKey in hasOpenPrAt)) {
      hasOpenPrAt[evKey] = await deps.getHasOpenPr(row.taskId, row.subagentSessionId);
    }
  }

  const flags = computeDispatchWatchdogFlags(
    rows,
    taskStatuses,
    {
      lastCommitAtMs: (sid) => commitAt[sid ?? ""] ?? null,
      lastEventAtMs: (taskId, sid) => eventAt[`${taskId}::${sid ?? ""}`] ?? null,
      sessionExists: (sid) => existsAt[sid ?? ""] ?? null,
      lastPresenceActivityAtMs: (sid) => presenceAt[sid ?? ""] ?? null,
      lastWorkspaceMtimeAtMs: (sid) => workspaceMtimeAt[sid ?? ""] ?? null,
      hasOpenPr: (taskId, sid) => hasOpenPrAt[`${taskId}::${sid ?? ""}`] ?? null,
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

/**
 * Resolve whether a subagent session's on-disk workspace still exists
 * (mt#3062). Returns `null` (unknown) rather than `false` (confirmed gone)
 * when there is no `subagentSessionId` to check, or when the existence
 * check itself throws (e.g. a permission error) — only a definite,
 * successfully-observed absence should suppress a flag; an inconclusive
 * check must not be conflated with "gone".
 */
export async function getSessionWorkspaceExists(
  subagentSessionId: string | null
): Promise<boolean | null> {
  if (!subagentSessionId) return null;
  const sessionDir = path.join(getSessionsDir(), subagentSessionId);
  try {
    return fs.existsSync(sessionDir);
  } catch {
    return null;
  }
}

/**
 * Resolve the freshest dirty-file mtime in a subagent session's git working
 * tree (mt#3193), delegating to the shared `resolveLastWorkspaceMtimeAtMs`
 * helper (`@minsky/domain/session/workspace-activity`) — the same query
 * `tasks.dispatch-recover`'s staleness check uses. Resolves the session
 * directory the same way the sibling `getSessionLastCommitAtMs`/
 * `getSessionWorkspaceExists` helpers do (`getSessionsDir()` + the raw
 * session id, since this producer works directly off `subagent_invocations`
 * rows rather than a resolved `SessionRecord`).
 *
 * **Contract caution (mt#3958), inherited from `resolveLastWorkspaceMtimeAtMs`:**
 * the returned mtime only advances on a dirty-file WRITE, not on a read/plan/
 * test cycle — a large "time since" computed from this value means "no
 * recent writes," not "no agent." Do not treat it alone as evidence of death.
 */
export async function getSessionWorkspaceLastMtimeAtMs(
  subagentSessionId: string | null
): Promise<number | null> {
  if (!subagentSessionId) return null;
  const sessionDir = path.join(getSessionsDir(), subagentSessionId);
  return resolveLastWorkspaceMtimeAtMs(sessionDir, { source: "dispatch-watchdog" });
}

/** Write a snapshot to the cache file (atomic temp+rename via the shared lifecycle helper). */
export function writeDispatchWatchdogCache(
  snapshot: DispatchWatchdogSnapshot,
  cachePath: string = getDispatchWatchdogCachePath()
): boolean {
  try {
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteJSON(cachePath, snapshot);
    return true;
  } catch (err) {
    log.warn("dispatch-watchdog: failed to write cache", {
      message: getLoggableErrorSummary(err),
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
  // Capability + the optional accessor, via the one guard (mt#4543).
  if (!hasRawSqlConnection(provider)) return null;
  const getRawSql = provider.getRawSqlConnection.bind(provider);

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
    getSessionExists: getSessionWorkspaceExists,
    // mt#3172: shares tasks.dispatch-recover's mt#3086 presence-claim query
    // via the extracted helper — `provider` (the same PersistenceProvider
    // this dep set's other capabilities are read from) satisfies the
    // helper's minimal `getDatabaseConnection`-shaped input.
    getLastPresenceActivityAtMs: (subagentSessionId) =>
      resolveLastPresenceActivityAtMs(subagentSessionId, provider, {
        source: "dispatch-watchdog",
      }),
    // mt#3193: shares tasks.dispatch-recover's mt#3193 workspace-mtime query
    // via the extracted helper.
    getLastWorkspaceMtimeAtMs: getSessionWorkspaceLastMtimeAtMs,
    // mt#3193: direct query — `sessions.pull_request` is the same JSON-text
    // column `dispatch-recover-command.ts` reads via `sessionRecord.pullRequest`
    // (there resolved through the SessionProvider; here read directly via SQL
    // since this producer already has a raw `sql` handle and no SessionProvider).
    // Parsing/interpretation is delegated to `parsePullRequestOpenState`
    // (below) — a PURE, independently-unit-tested function — rather than
    // inlined here, per PR #2307 R1 BLOCKING #2 (a malformed JSON blob must
    // NOT silently degrade to "unknown" and re-enable the false positive
    // this gate exists to suppress).
    getHasOpenPr: async (_taskId, subagentSessionId) => {
      if (!subagentSessionId) return null;
      const rows = (await sql.unsafe(HAS_OPEN_PR_QUERY, [subagentSessionId])) as Array<{
        pull_request: string | null;
      }>;
      return parsePullRequestOpenState(rows?.[0]?.pull_request ?? null, subagentSessionId);
    },
    getLastEventAtMs: async (taskId, subagentSessionId) => {
      const rows = (await sql.unsafe(LAST_EVENT_AT_QUERY, [taskId, subagentSessionId])) as Array<{
        latest_at: string | number | null;
      }>;
      const raw = rows?.[0]?.latest_at;
      if (raw === null || raw === undefined) return null;
      const ms = Number(raw);
      return Number.isFinite(ms) ? ms : null;
    },
  };
}

/**
 * Query for the last related `system_events` row's timestamp, converted to
 * epoch-milliseconds.
 *
 * `system_events.created_at` is `timestamp with time zone` — casting it
 * directly to `::bigint` (as the sibling `prod-state-cache.ts` query does for
 * `drizzle.__drizzle_migrations.created_at`, a genuinely bigint column there)
 * is an INVALID Postgres cast and errors at query time. `extract(epoch from
 * ...)` converts the timestamptz to a numeric epoch-SECONDS value first,
 * which is then scaled to milliseconds (matching the ms unit every other
 * activity-signal timestamp in this module uses) before the bigint cast.
 */
export const LAST_EVENT_AT_QUERY = `SELECT (extract(epoch from max(created_at)) * 1000)::bigint AS latest_at
         FROM system_events
         WHERE related_task_id = $1 OR ($2::text IS NOT NULL AND related_session_id = $2)`;

/**
 * Query for a session's raw `pull_request` JSON-text column (mt#3193),
 * keyed by the Minsky session id — the same id `subagent_invocations.subagent_session_id`
 * stores and `sessions.session` primary-keys on. The result is JSON-parsed
 * by the caller (`buildRealDispatchWatchdogDeps`'s `getHasOpenPr`), not by
 * this query, since `sql.unsafe` returns the raw text column value.
 */
export const HAS_OPEN_PR_QUERY = `SELECT pull_request FROM sessions WHERE session = $1`;

/**
 * Interpret a session's raw `pull_request` JSON-text column value as
 * open/draft (`true`), closed/merged (`false`), or "no PR ever recorded"
 * (`null`) — mt#3193, refined per PR #2307 R1 BLOCKING #2.
 *
 * The key design point: a non-null, non-empty `raw` value is ITSELF
 * positive evidence a PR was recorded for this session, even when its
 * `state` can't be determined — either because `JSON.parse` throws, or
 * because a parsed `state` value isn't one of the four this function
 * recognizes (e.g. future schema drift). Degrading THOSE cases to `null`
 * would be wrong: the IN-REVIEW+open-PR exclusion
 * (`computeDispatchWatchdogFlags`) treats `null` as "no evidence, evaluate
 * normally" — so a malformed-but-real PR record would silently fall
 * straight back into staleness evaluation, reintroducing the exact false
 * positive this gate exists to suppress. Only a genuinely NULL/empty
 * column (no PR ever recorded for this session) returns `null`; every
 * other outcome resolves to `true` or `false`, with a warning logged
 * (including the session id) for the two "recorded but not cleanly
 * `open`/`draft`/`closed`/`merged`" cases so the anomaly stays diagnosable.
 *
 * Pure function (aside from the log calls) — no I/O, easily unit-tested.
 */
export function parsePullRequestOpenState(
  raw: string | null | undefined,
  subagentSessionId: string | null
): boolean | null {
  if (!raw) return null;

  let state: unknown;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown };
    state = parsed?.state;
  } catch (err) {
    log.warn(
      "dispatch-watchdog: unparseable pull_request JSON — treating as evidence of an " +
        "existing PR (state unknown) rather than degrading to no-evidence",
      { subagentSessionId, error: getLoggableErrorSummary(err) }
    );
    return true;
  }

  if (state === "closed" || state === "merged") return false;
  if (state === "open" || state === "draft") return true;

  log.warn(
    "dispatch-watchdog: pull_request JSON has an unrecognized/missing state — treating as " +
      "evidence of an existing PR rather than degrading to no-evidence",
    { subagentSessionId, state }
  );
  return true;
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
    const wrote = writeDispatchWatchdogCache(snapshot, cachePath);
    if (wrote) {
      DispatchWatchdogSweepTracker.getInstance().recordTick(snapshot.flags.length, nowMs);
    } else {
      DispatchWatchdogSweepTracker.getInstance().recordError(nowMs);
    }
    return wrote;
  } catch (err) {
    DispatchWatchdogSweepTracker.getInstance().recordError(nowMs);
    log.warn("dispatch-watchdog: refresh failed", {
      message: getLoggableErrorSummary(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sweep observability tracker (R1 non-blocking #2) — mirrors
// TranscriptSweepTracker's (src/cockpit/transcript-sweep-tracker.ts)
// in-memory-singleton-with-counters shape, kept intentionally minimal: ticks
// run, cumulative flags written across all ticks, and the last-snapshot
// timestamp/age. Same redaction policy as its sibling — no raw error
// messages stored (the log surface carries those); only counts + ISO
// timestamps are exposed.
// ---------------------------------------------------------------------------

/** Snapshot of the dispatch-watchdog sweep's health counters. */
export interface DispatchWatchdogSweepSummary {
  /** Total number of completed (cache-written) sweep ticks. */
  ticksRun: number;
  /** Cumulative count of flagged dispatches written across all ticks (not deduplicated across ticks — a persistently-stalled dispatch counts once per tick). */
  flagsWritten: number;
  /** ISO timestamp of the last successfully-written snapshot, or null (no tick has succeeded yet). */
  lastSnapshotAt: string | null;
  /** Age of the last successful snapshot in ms at read time, or null. */
  lastSnapshotAgeMs: number | null;
  /** ISO timestamp of the last tick error (DB unavailable, write failure, unexpected throw), or null. */
  lastErrorAt: string | null;
}

export class DispatchWatchdogSweepTracker {
  private static _instance: DispatchWatchdogSweepTracker | null = null;

  private ticksRun = 0;
  private flagsWritten = 0;
  private lastSnapshotAtMs: number | null = null;
  private lastErrorAtMs: number | null = null;

  /** Process-lifetime singleton (created on first access). */
  static getInstance(): DispatchWatchdogSweepTracker {
    if (!DispatchWatchdogSweepTracker._instance) {
      DispatchWatchdogSweepTracker._instance = new DispatchWatchdogSweepTracker();
    }
    return DispatchWatchdogSweepTracker._instance;
  }

  /** Reset the singleton for tests. */
  static resetForTest(): DispatchWatchdogSweepTracker {
    DispatchWatchdogSweepTracker._instance = new DispatchWatchdogSweepTracker();
    return DispatchWatchdogSweepTracker._instance;
  }

  /** Record a completed tick that successfully wrote a snapshot. */
  recordTick(flagCount: number, nowMs: number = Date.now()): void {
    this.ticksRun += 1;
    this.flagsWritten += flagCount < 0 ? 0 : flagCount;
    this.lastSnapshotAtMs = nowMs;
  }

  /** Record a tick-level error (no raw message — redaction policy). */
  recordError(nowMs: number = Date.now()): void {
    this.lastErrorAtMs = nowMs;
  }

  /** Snapshot the current counters for the cockpit `/api/health` surface. */
  getSummary(nowMs: number = Date.now()): DispatchWatchdogSweepSummary {
    return {
      ticksRun: this.ticksRun,
      flagsWritten: this.flagsWritten,
      lastSnapshotAt:
        this.lastSnapshotAtMs === null ? null : new Date(this.lastSnapshotAtMs).toISOString(),
      lastSnapshotAgeMs: this.lastSnapshotAtMs === null ? null : nowMs - this.lastSnapshotAtMs,
      lastErrorAt: this.lastErrorAtMs === null ? null : new Date(this.lastErrorAtMs).toISOString(),
    };
  }
}
