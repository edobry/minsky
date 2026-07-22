/**
 * Driven-session registry persistence store (mt#3038, RFC "Conversation-first
 * drive" Phase 1 — Notion `3a5937f0-3cb4-814c-990f-c1e3174b33e0`).
 *
 * Read/write access to `driven_sessions`
 * (../storage/schemas/driven-sessions-schema.ts) — the durable, rehydratable
 * record that makes a cockpit driven session (mt#2750) survive a daemon
 * restart — plus the CROSS-PROCESS advisory lock the RFC's R1 expert-review
 * delta #1 (BINDING) requires be held before ANY resume-spawn: the
 * daemon-side in-memory registry (src/cockpit/driven-session-host.ts) is
 * per-process and cannot by itself prevent two daemons (a routine situation
 * in this project's dev loop — see src/cockpit/CLAUDE.md §Operator dev loop,
 * a dev cockpit running beside the tray-supervised daemon) from both
 * deciding to `claude --resume` the SAME conversation id concurrently, which
 * would race two processes against one on-disk transcript file.
 *
 * Reads use raw `db.execute(sql\`...\`)` (the established precedent in this
 * codebase — see scripts/backfill-session-short-ids.ts,
 * scripts/backfill-agent-transcript-turns.ts,
 * services/reviewer/src/inflight-marker.ts) rather than the drizzle query
 * builder's `.select().from().where()` chain — both are equally valid
 * drizzle usage, but raw SQL keeps this module's row-mapping (`mapRawRow`)
 * independently unit-testable against a trivial `db.execute` fake, without
 * needing to fake the query-builder's internal chain shape.
 *
 * This module deliberately imports NOTHING from `src/cockpit/**` — the
 * daemon-domain boundary this codebase already draws in the other direction
 * (see ../../../../src/cockpit/driven-session-host.ts's module docblock:
 * "this module imports NOTHING from `@anthropic-ai/*`"); driven-session-launch.ts
 * is the daemon-side caller of this store, mirroring how it already calls
 * ./driven-session-cost-writer.ts and ./driven-link-writer.ts.
 *
 * @see mt#3038 — this module
 * @see ../storage/schemas/driven-sessions-schema.ts — the table
 * @see scripts/backfill-session-short-ids.ts — the pg_try_advisory_lock() row-access precedent this mirrors
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import {
  drivenSessionsTable,
  type DrivenSessionRow,
  type PersistedDrivenSessionStatus,
} from "../storage/schemas/driven-sessions-schema";

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export interface UpsertDrivenSessionInput {
  localId: string;
  harnessSessionId?: string | null;
  cwd: string;
  permissionMode: string;
  taskId?: string | null;
  minskySessionId?: string | null;
  status: PersistedDrivenSessionStatus;
  unrecoverableReason?: string | null;
  pid?: number | null;
  pidCmdline?: string | null;
  actuatorGeneration?: number;
  /** The principal-selected model alias (mt#3040), e.g. "fable" — persisted
   * so a restart-recovery resume (mt#3038) preserves it. */
  model?: string | null;
  /** ISO timestamp of the ORIGINAL spawn (stable across an actuator swap — see schema docblock). */
  startedAt: string;
}

export type UpsertDrivenSessionOutcome = "written" | "error";

/**
 * Upsert one driven-session row by `localId`. Called on every meaningful
 * in-memory state transition (spawn, init-link, exit/crash, resume-respawn)
 * so the persisted record always reflects the daemon's in-memory
 * `DrivenSessionRecord` — the "make the in-memory Map a rehydratable record"
 * step of the RFC's minimal first slice. Never throws — a failed write is
 * logged and swallowed (mirrors the sibling writers' convention in this
 * directory) so persistence failures never disturb the live session.
 */
export async function upsertDrivenSessionRecord(
  db: PostgresJsDatabase,
  input: UpsertDrivenSessionInput
): Promise<UpsertDrivenSessionOutcome> {
  try {
    const values = {
      localId: input.localId,
      harnessSessionId: input.harnessSessionId ?? null,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      taskId: input.taskId ?? null,
      minskySessionId: input.minskySessionId ?? null,
      status: input.status,
      unrecoverableReason: input.unrecoverableReason ?? null,
      pid: input.pid ?? null,
      pidCmdline: input.pidCmdline ?? null,
      model: input.model ?? null,
      actuatorGeneration: input.actuatorGeneration ?? 0,
      startedAt: new Date(input.startedAt),
      updatedAt: new Date(),
    };
    await db
      .insert(drivenSessionsTable)
      .values(values)
      .onConflictDoUpdate({ target: drivenSessionsTable.localId, set: values });
    return "written";
  } catch (err) {
    log.warn(`upsertDrivenSessionRecord: failed for ${input.localId}`, {
      error: getErrorMessage(err),
    });
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Reads (raw SQL — see module docblock for why)
// ---------------------------------------------------------------------------

/** Shape of one raw row as returned by `postgres-js` (snake_case column names). */
interface RawDrivenSessionRow {
  local_id: string;
  harness_session_id: string | null;
  cwd: string;
  permission_mode: string;
  task_id: string | null;
  minsky_session_id: string | null;
  status: string;
  unrecoverable_reason: string | null;
  pid: number | null;
  pid_cmdline: string | null;
  model: string | null;
  actuator_generation: number;
  started_at: Date | string;
  updated_at: Date | string;
}

/** Pure mapping — unit-tested directly, independent of any DB fake. */
export function mapRawDrivenSessionRow(raw: RawDrivenSessionRow): DrivenSessionRow {
  return {
    localId: raw.local_id,
    harnessSessionId: raw.harness_session_id,
    cwd: raw.cwd,
    permissionMode: raw.permission_mode,
    taskId: raw.task_id,
    minskySessionId: raw.minsky_session_id,
    status: raw.status,
    unrecoverableReason: raw.unrecoverable_reason,
    pid: raw.pid,
    pidCmdline: raw.pid_cmdline,
    model: raw.model,
    actuatorGeneration: raw.actuator_generation,
    startedAt: raw.started_at instanceof Date ? raw.started_at : new Date(raw.started_at),
    updatedAt: raw.updated_at instanceof Date ? raw.updated_at : new Date(raw.updated_at),
  };
}

/** Look up one persisted driven-session row by `localId`. Returns `null` on any error or miss. */
export async function getDrivenSessionRecord(
  db: PostgresJsDatabase,
  localId: string
): Promise<DrivenSessionRow | null> {
  try {
    const result = await db.execute(
      sql`SELECT * FROM driven_sessions WHERE local_id = ${localId} LIMIT 1`
    );
    const rows = Array.from(result as Iterable<RawDrivenSessionRow>);
    return rows[0] ? mapRawDrivenSessionRow(rows[0]) : null;
  } catch (err) {
    log.warn(`getDrivenSessionRecord: failed for ${localId}`, { error: getErrorMessage(err) });
    return null;
  }
}

/**
 * List every NON-terminal persisted record — the boot-reconciliation read
 * (RFC minimal-first-slice step 2): daemon startup loads these into the
 * in-memory registry as `"reconnecting"`, WITHOUT eagerly respawning (R1
 * delta #6 — resumes are lazy-only, triggered by an operator action or
 * client reconnect, never fired automatically at boot — the
 * fingerprinting-cadence threat the RFC's threat model names). Terminal
 * statuses (`exited`/`crashed`/`unrecoverable`) are excluded by the query
 * itself, not filtered client-side, so a large historical table never gets
 * fully scanned into memory at boot.
 */
export async function listNonTerminalDrivenSessions(
  db: PostgresJsDatabase
): Promise<DrivenSessionRow[]> {
  try {
    const result = await db.execute(
      sql`SELECT * FROM driven_sessions WHERE status NOT IN ('exited', 'crashed', 'unrecoverable')`
    );
    return Array.from(result as Iterable<RawDrivenSessionRow>).map(mapRawDrivenSessionRow);
  } catch (err) {
    log.warn(`listNonTerminalDrivenSessions: failed`, { error: getErrorMessage(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cross-process resume lock (R1 expert-review delta #1, BINDING)
// ---------------------------------------------------------------------------

/**
 * Fixed advisory-lock namespace for driven-session resume-spawn exclusion.
 * Arbitrary but stable, distinguishing this lock class from any other
 * advisory lock in this codebase (see
 * scripts/backfill-session-short-ids.ts's `BACKFILL_ADVISORY_LOCK_KEY` for
 * the sibling single-key convention this namespaces against) — combined
 * with `hashtext(conversationId)` via the two-key
 * `pg_try_advisory_xact_lock(int, int)` overload, so no JS-side string
 * hashing is needed.
 */
const DRIVEN_SESSION_RESUME_LOCK_NAMESPACE = 3_038_001;

export type WithDrivenSessionResumeLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false };

/**
 * Run `fn` while holding a TRANSACTION-SCOPED (`pg_try_advisory_xact_lock`)
 * advisory lock keyed on `conversationId` (the harness session id being
 * resumed). Transaction-scoped rather than session-scoped: this runs inside
 * a pooled `postgres-js` connection where a plain `pg_try_advisory_lock` /
 * `pg_advisory_unlock` pair (the session-scoped convention in
 * scripts/backfill-session-short-ids.ts, safe there because that script
 * pins a single connection for its whole run) could acquire and release on
 * DIFFERENT pooled connections — the xact-scoped variant is automatically
 * released when the transaction ends regardless of connection reuse, the
 * correct default for a long-lived daemon sharing a connection pool.
 *
 * If the lock is NOT acquired (another process — routinely a second cockpit
 * daemon in this project's dev loop, see src/cockpit/CLAUDE.md §Operator dev
 * loop — is already resuming the same conversation), `fn` is never invoked;
 * the caller MUST treat `{ acquired: false }` as "someone else is already
 * resuming this conversation — do not spawn."
 */
export async function withDrivenSessionResumeLock<T>(
  db: PostgresJsDatabase,
  conversationId: string,
  fn: () => Promise<T>
): Promise<WithDrivenSessionResumeLockResult<T>> {
  return db.transaction(async (tx) => {
    const lockRows = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${DRIVEN_SESSION_RESUME_LOCK_NAMESPACE}, hashtext(${conversationId})) AS acquired`
    );
    const row = Array.from(lockRows as Iterable<Record<string, unknown>>)[0];
    if (row?.["acquired"] !== true) {
      return { acquired: false };
    }
    const result = await fn();
    return { acquired: true, result };
  });
}
