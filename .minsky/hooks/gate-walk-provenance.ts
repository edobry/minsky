#!/usr/bin/env bun
// PreToolUse observer at the MERGE seam: was this task ever gated at all? (mt#1880)
//
// ===========================================================================
// THE QUESTION, AND WHY IT IS NOT THE ONE THE ORIGINAL SPEC ASKED
// ===========================================================================
//
// mt#1880 was filed in 2026-05 asking a merge-time hook to "run gate (g) and
// gate (h) against the linked task's spec." Neither gate discharges INTO the
// spec: (g)'s discharge is three probe calls and (h)'s is the sweep's directory
// arguments, and both live in the PLANNING session's transcript. At
// `session_pr_merge` a guard sees the MERGING session's transcript, routinely a
// different conversation — and for the bypass paths this guard exists to catch
// there is no planning session at all. There is no transcript join available
// here, so "run gate (h) against the spec" has no artifact to run against.
//
// ADR-042 §Sibling reconciliation states the question this seam CAN answer, and
// distinguishes it from the sibling's in the same bullet:
//
//   mt#4171, at `pr`    — the sweep ran; did it cover the directories gate (h)
//                         prescribes? It presupposes the gate was walked and
//                         checks the SCOPE of what it did.
//   mt#1880, at `merge` — was this task ever gated at all? It presupposes
//                         nothing, which is the whole point, and is the only one
//                         of the two that fires on a task that skipped PLANNING.
//
// EXISTENCE, NOT SCOPE. mem#416 enumerates four ways to reach shipped code with
// `/plan-task` never running: TODO → IN-PROGRESS directly via `session_start`;
// shipping under a different task id; a manual `tasks_status_set`; external
// advancement past PLANNING. Merge is the only seam all four pass through.
//
// ===========================================================================
// THE SIGNAL: A `task.status_changed` ROW WITH `newStatus: "READY"`
// ===========================================================================
//
// Structured, not prose — a row read against a table, with no paraphrase axis,
// which is ADR-042's discriminator for a mechanizable row. Three measured
// properties shape the implementation; all three are in mt#1880's spec:
//
//  1. ONE EMITTER. `src/adapters/shared/commands/tasks/status-commands.ts:172`
//     is the only call site, so the stream sees the `tasks.status.set` COMMAND
//     path and nothing else.
//
//  2. THAT ASYMMETRY FAVOURS THIS CHECK AND WOULD SINK A DIFFERENT ONE. Over the
//     500 most recent events: `TODO→PLANNING` 235, `PLANNING→READY` 223,
//     `READY→IN-PROGRESS` 4, `IN-PROGRESS→IN-REVIEW` 0. `session_start` and
//     `session_pr_create` bypass the command, so those two transitions are
//     nearly or entirely absent. `→ READY` — the one `/plan-task` makes via the
//     command — is the best-covered transition in the stream. A check needing
//     `IN-REVIEW` could not be built on this substrate at all.
//
//  3. TWO REASONS ABSENCE IS NOT EVIDENCE, and they are why this ships
//     record-only rather than why it should be skipped:
//       - EMISSION HORIZON. `events_list --until 2026-06-10` returns 0 and
//         `--until 2026-06-15` returns 141, so emission began between those
//         dates (mt#2340). A task that reached READY before then has no row and
//         never will.
//       - BEST-EFFORT EMISSION. `status-commands.ts:49` logs
//         "event emission failed (best-effort, swallowed)" and continues, so a
//         genuine gate-walk can leave no row.
//
// Both are `claim-confidence.mdc §Absence in a derived view`: the stream is
// accurate about ITSELF and silent about whether the gate ran. So the outcome
// vocabulary keeps "cannot tell" separate from "was not gated" — see
// `classifyGateWalk`, where that split is the whole design.
//
// ===========================================================================
// RECORD-ONLY, AND THE HORIZON IS READ RATHER THAN CARRIED
// ===========================================================================
//
// This guard NEVER denies and NEVER injects. ADR-042 §Posture ships every new
// row calibration-first per ADR-024's ladder and assigns the (g)/(h) rows
// `tuningOwnership: "advisory"`, with the reason stated there: a provenance
// check joins a claim against a record, and a missed record is a false positive
// fired at an author who did the work. Property 3 above names two independent
// ways that can happen here. Posture is operator-reserved; a later flip is a
// decision, not an implementation step.
//
// The horizon is DERIVED from the earliest `task.status_changed` row on every
// invocation, never carried as a literal date. A hardcoded date is wrong in the
// silent direction: it keeps parsing, keeps comparing, and quietly reclassifies
// tasks as the stream's real history moves.
//
// Override: MINSKY_SKIP_GATE_WALK_PROVENANCE=1.
//
// @see docs/architecture/hooks/gate-walk-provenance.md — mechanism, bounds, calibration
// @see ADR-042 — the row this implements, its seam, and its posture
// @see .minsky/hooks/enumeration-scope-check.ts — the sibling at `pr` (scope, not existence)
// @see scripts/replay-gate-walk-provenance.ts — the SC8 measurement

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findRepoRoot, readInput } from "./types";
import type { ToolHookInput } from "./types";
import { makeRecordAndExit } from "./merge-gate-fire-log";
import type { MergeGateFireLogContext, RecordAndExit } from "./merge-gate-fire-log";
import { resolveMergeGateTaskId } from "./merge-gate-task-resolution";
import { describeProviderResolutionFailure, ensureHookDomainBootstrap } from "./domain-bootstrap";
// Type-only, so it is erased at runtime and the module's domain imports stay
// dynamic per `.minsky/hooks/SPEC.md` — the same narrowing
// `duplicate-signature-scan.ts` uses. The base provider declares
// `getDatabaseConnection?(): Promise<unknown>` because subclasses return
// different concrete DB types; without this narrowing the connection is `{}`
// and `.execute` is not callable on it.
import type { SqlCapablePersistenceProvider } from "../../packages/domain/src/persistence/types";

/** Guard name — the `MINSKY_HOOK_OVERRIDE` key and the fire-log discriminator. */
export const GUARD_NAME = "gate-walk-provenance";

/** Override env var. Registered in `HOOK_ONLY_ENV_VAR_CATEGORIES` as `operator-override`. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_GATE_WALK_PROVENANCE";

/** Calibration log (mt#2263 ladder) — repo-root relative. */
export const CALIBRATION_LOG = ".minsky/gate-walk-provenance-calibration.jsonl";

/**
 * Deadline for the whole three-query read.
 *
 * ADR-028 §Context measures this seam's PreToolUse timeouts summing to 150s
 * across (then) four guards; `.claude/settings.json` now lists six and this is
 * the seventh. The budget is affordable only because the read is three indexed
 * local queries with no forge round-trip — cheaper than the `gh api` calls its
 * siblings already make. The deadline bounds it INSIDE the guard rather than
 * trusting the registration's `timeoutMs`, which ADR-042 §Family placement
 * records as declarative and unenforced: nothing in the dispatch loop reads it,
 * and this seam has no dispatcher at all.
 */
export const READ_TIMEOUT_MS = 10_000;

/** The `unavailable` cause for a provider that resolved but handed back no connection. */
export const NO_DB_CONNECTION = "no database connection";

// ---------------------------------------------------------------------------
// The functional core (mt#3632 §Testable design): facts in, classification out
// ---------------------------------------------------------------------------

/**
 * What the merge-seam check concluded about ONE task.
 *
 * `skipped` is deliberately NOT a flavour of `ungated`. Property 3 in the header
 * gives two ways a genuinely-gated task leaves no row, so collapsing them would
 * make "we cannot tell" indistinguishable from "nobody gated this" in the very
 * corpus the posture decision will be made from. Every `skipped` carries a
 * `reason` naming which channel came up empty.
 */
export type GateWalkOutcome = "gated" | "ungated" | "skipped";

/** The three reads the classification is a pure function of. */
export interface GateWalkFacts {
  /** ISO timestamp of the earliest `→ READY` row for this task, or null if none. */
  readyEventAt: string | null;
  /** ISO timestamp of the earliest `task.status_changed` row in the stream, or null. */
  horizonAt: string | null;
  /** ISO timestamp the bound task row was created, or null when the row/column is absent. */
  taskCreatedAt: string | null;
  /**
   * Set when the read did not COMPLETE — bootstrap failure, no provider, a
   * timeout, a query error.
   *
   * Kept as a separate field rather than letting the three nulls speak, because
   * a failed read and an empty stream produce identical nulls and mean opposite
   * things. A guard whose broken-probe path returned the same value as its
   * healthy-and-empty path would report an outage as a run of correct behavior
   * (mem#704).
   */
  unavailable?: string;
}

export interface GateWalkClassification {
  outcome: GateWalkOutcome;
  reason: string;
}

/**
 * Classify one task's gate-walk provenance. Pure — no IO, no clock, no env.
 *
 * Order is load-bearing. A found `→ READY` row settles the question BEFORE any
 * horizon reasoning: a positive is a positive even for a task whose row predates
 * the horizon we computed, and reversing these two would let a bookkeeping
 * question override direct evidence.
 */
export function classifyGateWalk(facts: GateWalkFacts): GateWalkClassification {
  if (facts.unavailable) {
    return {
      outcome: "skipped",
      // Named, not generic: a hook process exits immediately after its decision,
      // so whatever this string carries is typically the only account of the
      // failure anyone ever reads.
      reason: `the event stream could not be read (${facts.unavailable}); absence here is not evidence`,
    };
  }

  if (facts.readyEventAt) {
    return { outcome: "gated", reason: `a → READY event exists (${facts.readyEventAt})` };
  }

  if (!facts.horizonAt) {
    return {
      outcome: "skipped",
      reason:
        "the stream holds no task.status_changed row at all, so it cannot answer whether this one is missing",
    };
  }

  if (!facts.taskCreatedAt) {
    return {
      outcome: "skipped",
      reason:
        "the bound task carries no creation timestamp, so it cannot be placed against the horizon",
    };
  }

  const created = Date.parse(facts.taskCreatedAt);
  const horizon = Date.parse(facts.horizonAt);
  if (!Number.isFinite(created) || !Number.isFinite(horizon)) {
    return {
      outcome: "skipped",
      reason: `unparseable timestamp (task ${facts.taskCreatedAt}, horizon ${facts.horizonAt})`,
    };
  }

  if (created < horizon) {
    return {
      outcome: "skipped",
      reason: `the task predates the emission horizon (created ${facts.taskCreatedAt}, horizon ${facts.horizonAt}), so the stream cannot answer`,
    };
  }

  return {
    outcome: "ungated",
    reason: `no → READY event, and the task was created after the emission horizon (${facts.horizonAt})`,
  };
}

/**
 * Classify one MERGE attempt, including the case where no task id resolved.
 *
 * The unresolved case is folded in here rather than handled inline at the entry
 * point so that all four of SC3's outcomes are decided by one pure function and
 * AT4 is a unit test rather than a process test. It is `skipped`, never
 * `ungated`: a dependabot or manual branch was never a candidate for gating, and
 * counting it as un-gated would inflate exactly the number this corpus exists to
 * measure.
 */
export function classifyMerge(args: {
  taskId: string | null;
  facts: GateWalkFacts;
}): GateWalkClassification {
  if (!args.taskId) {
    return {
      outcome: "skipped",
      reason:
        "no task id resolved from tool_input.task, the cwd branch, or a sessionId workspace — not a task/mt-N merge",
    };
  }
  return classifyGateWalk(args.facts);
}

/**
 * The fire-log decision this guard reports, for every classification.
 *
 * A function rather than a constant so AT6 can assert it over the whole outcome
 * space instead of reading a flag: "never denies" is a property of the code
 * path, and a `denyCapable: false` registration is a DECLARATION about it.
 */
export function fireLogDecisionFor(_classification: GateWalkClassification): "allow" {
  return "allow";
}

/** True when the operator override is set. */
export function isOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[OVERRIDE_ENV_VAR];
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

/**
 * The `gh api PUT .../pulls/<N>/merge` bypass path, matched the same way its five
 * siblings on the `Bash|mcp__minsky__session_exec` matcher already match it
 * (`block-subagent-bypass-merge.ts`, `require-checks-on-bypass-merge.ts`,
 * `block-out-of-band-merge.ts`).
 *
 * This guard runs at BOTH merge surfaces, and the bypass one is not an
 * afterthought: a merge that routes around `session_pr_merge` is exactly where a
 * never-gated task most plausibly reaches main, so a corpus blind to it would
 * under-count `ungated` in the measurement the posture decision is made from.
 *
 * Returns the PR number when the command IS a bypass merge, else null. The null
 * case is the overwhelming majority of `Bash` calls and must stay cheap — the
 * entry point exits on it before doing any database work, and deliberately
 * without writing a calibration record: a record per shell command would bury
 * the merge signal in noise, and "this was not a merge" is not a merge outcome.
 */
export function bypassMergePrNumber(command: string): number | null {
  const m = /\/pulls\/(\d+)\/merge\b/.exec(command);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a task id to the `mt#N` form `system_events.related_task_id` stores.
 *
 * `resolveMergeGateTaskId` already returns `mt#N` from its branch channel, but
 * its `tool_input.task` channel passes caller text through verbatim — and a
 * `mt1880` there would match no row and read as `ungated`, which is the
 * false-positive direction. Anything that is not recognisably a task id is
 * returned unchanged and simply matches nothing.
 */
export function normalizeTaskId(taskId: string): string {
  const match = taskId.trim().match(/^mt#?(\d+)$/i);
  return match ? `mt#${match[1]}` : taskId.trim();
}

// ---------------------------------------------------------------------------
// The imperative shell: three indexed reads on one connection
// ---------------------------------------------------------------------------

const TIMED_OUT = Symbol("gate-walk-provenance timeout");

/**
 * Read the three facts. Never rejects — every failure becomes `unavailable`, so
 * the classifier above sees a value rather than an exception and the guard's
 * fail-open contract is satisfied by construction.
 */
export async function readGateWalkFacts(
  taskId: string,
  timeoutMs: number = READ_TIMEOUT_MS
): Promise<GateWalkFacts> {
  const empty: GateWalkFacts = { readyEventAt: null, horizonAt: null, taskCreatedAt: null };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((res) => {
    timer = setTimeout(() => res(TIMED_OUT), timeoutMs);
  });

  const read = runRead(taskId).catch(
    (err: unknown): GateWalkFacts => ({
      ...empty,
      unavailable: `read rejected: ${err instanceof Error ? err.message : String(err)}`,
    })
  );

  try {
    const outcome = await Promise.race([read, deadline]);
    if (outcome === TIMED_OUT) {
      return { ...empty, unavailable: `read exceeded the ${timeoutMs}ms deadline` };
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The un-raced read body. Converts every failure to a value. */
async function runRead(taskId: string): Promise<GateWalkFacts> {
  const empty: GateWalkFacts = { readyEventAt: null, horizonAt: null, taskCreatedAt: null };

  const bootstrap = await ensureHookDomainBootstrap();
  if (!bootstrap.ok)
    return { ...empty, unavailable: `domain bootstrap failed: ${bootstrap.error}` };

  const { resolvePersistenceProviderOrError } = await import(
    "../../packages/domain/src/persistence/factory"
  );
  const resolution = await resolvePersistenceProviderOrError();
  if (!resolution.ok)
    return { ...empty, unavailable: describeProviderResolutionFailure(resolution) };

  const provider = resolution.provider;
  if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
    return { ...empty, unavailable: `provider ${provider.constructor.name} is not SQL-capable` };
  }
  const db = await (provider as SqlCapablePersistenceProvider).getDatabaseConnection();
  if (!db) return { ...empty, unavailable: NO_DB_CONNECTION };

  const { sql } = await import("drizzle-orm");

  // Query 1 — the emission horizon, derived rather than carried. `min()` over an
  // event_type-filtered scan; one row back, no payloads.
  const horizonRows = await db.execute(sql`
    select min(created_at) as horizon
    from system_events
    where event_type = 'task.status_changed'
  `);
  const horizonAt = firstIsoField(horizonRows, "horizon");

  // Query 2 — the task's own creation time, needed to place it against the
  // horizon. Nullable in the schema (`created_at` has a default but no NOT
  // NULL), so a null here is a real case and the classifier handles it.
  const taskRows = await db.execute(sql`
    select created_at as created
    from tasks
    where id = ${taskId}
    limit 1
  `);
  const taskCreatedAt = firstIsoField(taskRows, "created");

  // Query 3 — the signal. `related_task_id` is the indexed column the emitter
  // stamps (`relatedTaskId: payload.taskId`); `newStatus` lives in the JSONB
  // payload. ASC + limit 1 so the recorded timestamp is the FIRST time the task
  // reached READY, which is the one a re-planned task's audit trail wants.
  const readyRows = await db.execute(sql`
    select created_at as fired
    from system_events
    where event_type = 'task.status_changed'
      and related_task_id = ${taskId}
      and payload->>'newStatus' = 'READY'
    order by created_at asc
    limit 1
  `);
  const readyEventAt = firstIsoField(readyRows, "fired");

  return { readyEventAt, horizonAt, taskCreatedAt };
}

/**
 * Pull one column off the first row of a driver result as an ISO string.
 *
 * The postgres-js driver hands timestamps back as `Date`, but a `min()` over an
 * empty set yields SQL NULL and some driver/route combinations stringify. Both
 * are normalized here so the classifier only ever sees `string | null`.
 */
export function firstIsoField(rows: unknown, field: string): string | null {
  const list = Array.isArray(rows) ? rows : null;
  const row = list && list.length > 0 ? list[0] : null;
  if (!row || typeof row !== "object") return null;
  const value = (row as Record<string, unknown>)[field];
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Calibration record
// ---------------------------------------------------------------------------

/** Build the JSONL record for one merge attempt. Pure, so tests can assert its shape. */
export function buildCalibrationRecord(args: {
  ts: string;
  sessionId: string | null;
  toolName: string | null;
  taskId: string | null;
  taskResolutionSource: string;
  classification: GateWalkClassification;
  facts: GateWalkFacts;
}): Record<string, unknown> {
  return {
    // `timestamp`, NOT `ts` (mt#4390). Every shared reader of a
    // `.minsky/*-calibration.jsonl` log keys on `timestamp`:
    // `checkCoverageReceipt` does `Date.parse(entry.timestamp)` and DROPS the
    // entry when that is NaN, and the calibration sweep renders `rec.timestamp`
    // in every branch. This guard emitted `ts` alone, so all 50 records on disk
    // were silently discarded before being counted — the receipt reported "no
    // live fires in the last 7d" about a log that had been appended to a minute
    // earlier. Measured: 0 live fires as written, 50 with the field renamed.
    // The other 44 declared logs all use `timestamp`; this was the lone outlier.
    timestamp: args.ts,
    guard: GUARD_NAME,
    sessionId: args.sessionId,
    toolName: args.toolName,
    taskId: args.taskId,
    taskResolutionSource: args.taskResolutionSource,
    outcome: args.classification.outcome,
    reason: args.classification.reason,
    readyEventAt: args.facts.readyEventAt,
    horizonAt: args.facts.horizonAt,
    taskCreatedAt: args.facts.taskCreatedAt,
    ...(args.facts.unavailable ? { unavailable: args.facts.unavailable } : {}),
  };
}

/**
 * Append one calibration record. Fail-safe: never throws — a log-write failure
 * must not affect a guard whose entire job is to record.
 */
export function appendCalibrationRecord(
  record: Record<string, unknown>,
  repoRootDir: string,
  logRelPath: string = CALIBRATION_LOG
): void {
  try {
    const logPath = resolve(repoRootDir, logRelPath);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    process.stderr.write(
      `[${GUARD_NAME}] Failed to write ${logRelPath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point (standalone — this seam has no dispatcher; ADR-042 §Family placement)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const startMs = Date.now();
  let recordAndExit: RecordAndExit | undefined;
  try {
    const input = await readInput<ToolHookInput>();
    const fireLogContext: MergeGateFireLogContext = {};
    // Bound to a non-optional local as well as the outer `let`. The outer one
    // exists only so the catch below can reach it, and its `| undefined` type
    // defeats the `never` return that makes every exit point below terminal —
    // without `exitWith`, TypeScript cannot see that the unresolved-task branch
    // does not fall through.
    const exitWith: RecordAndExit = makeRecordAndExit(
      GUARD_NAME,
      startMs,
      input,
      undefined,
      fireLogContext
    );
    recordAndExit = exitWith;

    if (isOverridden()) {
      process.stderr.write(
        `[${GUARD_NAME}] OVERRIDE: ${OVERRIDE_ENV_VAR} set session=${
          input.session_id ?? "unknown"
        } ts=${new Date().toISOString()}\n`
      );
      exitWith("allow", {
        overrideEnvVar: OVERRIDE_ENV_VAR,
        overrideClassification: "authorized_exception",
      });
    }

    // This guard is registered at BOTH merge surfaces: the `session_pr_merge`
    // tool and the `gh api PUT .../pulls/N/merge` bypass on
    // `Bash|mcp__minsky__session_exec`. On the shell matcher almost every call
    // is not a merge, so bail before touching the database — and WITHOUT a
    // calibration record, since "not a merge" is not a merge outcome and one
    // record per shell command would bury the signal.
    const toolName = input.tool_name ?? "";
    if (toolName === "Bash" || toolName === "mcp__minsky__session_exec") {
      const command = input.tool_input?.["command"];
      if (typeof command !== "string" || bypassMergePrNumber(command) === null) {
        exitWith("allow");
      }
    }

    const resolution = resolveMergeGateTaskId(input);
    fireLogContext.taskResolutionSource = resolution.source;
    const repoRootDir = findRepoRoot(input.cwd);
    const base = {
      ts: new Date().toISOString(),
      sessionId: input.session_id ?? null,
      toolName: input.tool_name ?? null,
      taskResolutionSource: resolution.source,
    };

    // SC3's fourth outcome: the branch does not follow `task/mt-N` and no other
    // channel named a task. Recorded as `skipped` — never `ungated`, and never a
    // silent early exit, because "this merge was not adjudicable" is exactly the
    // fact the calibration corpus needs in order to bound its own coverage.
    if (!resolution.taskId) {
      const noFacts: GateWalkFacts = { readyEventAt: null, horizonAt: null, taskCreatedAt: null };
      const classification = classifyMerge({ taskId: null, facts: noFacts });
      appendCalibrationRecord(
        buildCalibrationRecord({ ...base, taskId: null, classification, facts: noFacts }),
        repoRootDir
      );
      exitWith(fireLogDecisionFor(classification), undefined, "decided");
    }

    const taskId = normalizeTaskId(resolution.taskId);
    const facts = await readGateWalkFacts(taskId);
    const classification = classifyMerge({ taskId, facts });

    appendCalibrationRecord(
      buildCalibrationRecord({ ...base, taskId, classification, facts }),
      repoRootDir
    );

    // RECORD-ONLY. No `writeOutput` on any path: this guard emits no
    // `permissionDecision` and no `additionalContext`, per ADR-042 §Posture.
    exitWith(fireLogDecisionFor(classification), undefined, "decided");
  } catch (err) {
    process.stderr.write(
      `[${GUARD_NAME}] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
    // The fire-log closure may not exist yet if `readInput` itself threw; falling
    // back to a bare exit is correct there — a merge must never be blocked by
    // this guard's own breakage.
    if (recordAndExit) recordAndExit("allow", undefined, "crashed");
    process.exit(0);
  }
}
