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
import { getLoggableErrorSummary } from "../errors/index";
import {
  drivenSessionConversationsTable,
  drivenSessionsTable,
  type AdoptionReason,
  type DrivenSessionRow,
  type PersistedDrivenSessionStatus,
} from "../storage/schemas/driven-sessions-schema";

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export interface UpsertDrivenSessionInput {
  localId: string;
  harnessSessionId?: string | null;
  /** Which harness drives this session (mt#4935). Defaults to `"claude-code"`,
   * matching the schema column's own default — every caller predating this
   * task keeps writing the same value it always implicitly meant. */
  harnessKind?: string;
  /** Which `DriverTransport` spawned/spawns it (mt#4935), by `DriverTransport.id`.
   * Defaults to `"claude-stream-json"` (the schema column's own default). */
  transportId?: string;
  /** The harness's own conversation id (mt#4935) — for Claude Code, the same
   * value as `harnessSessionId`. Nullable for the same reason that field is:
   * unknown until the child's `init` event links it. */
  harnessConversationId?: string | null;
  /** Credential/identity posture this drive runs under (mt#4935) —
   * `"subscription"` or `"api-key"`. Defaults to `"subscription"` (the
   * schema column's own default). */
  authMode?: string;
  cwd: string;
  permissionMode: string;
  taskId?: string | null;
  minskySessionId?: string | null;
  status: PersistedDrivenSessionStatus;
  unrecoverableReason?: string | null;
  pid?: number | null;
  pidCmdline?: string | null;
  driverGeneration?: number;
  /** The principal-selected model alias (mt#3040), e.g. "fable" — persisted
   * so a restart-recovery resume (mt#3038) preserves it. */
  model?: string | null;
  /** ISO timestamp of the ORIGINAL spawn (stable across a session driver swap — see schema docblock). */
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
      harnessKind: input.harnessKind ?? "claude-code",
      transportId: input.transportId ?? "claude-stream-json",
      harnessConversationId: input.harnessConversationId ?? null,
      authMode: input.authMode ?? "subscription",
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      taskId: input.taskId ?? null,
      minskySessionId: input.minskySessionId ?? null,
      status: input.status,
      unrecoverableReason: input.unrecoverableReason ?? null,
      pid: input.pid ?? null,
      pidCmdline: input.pidCmdline ?? null,
      model: input.model ?? null,
      driverGeneration: input.driverGeneration ?? 0,
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
      error: getLoggableErrorSummary(err),
    });
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Conversation adoptions (mt#4323, ADR-044)
// ---------------------------------------------------------------------------

export interface RecordConversationAdoptionInput {
  localId: string;
  harnessSessionId: string;
  harness: string;
  driverGeneration?: number;
  adoptionReason: AdoptionReason;
}

/**
 * Append one adoption event for a driven session.
 *
 * INSERT-only by contract — never an upsert. Two adoptions of the SAME
 * conversation id on the same session are two events and get two rows: a
 * session that resumed a conversation, lost it, and resumed it again really
 * did adopt it twice, and collapsing that would erase the interval between.
 *
 * Never throws. A failed adoption write must not fail the spawn that
 * triggered it — this row is recovery state, and losing one is strictly
 * better than refusing to start an agent. The failure IS logged loudly,
 * because a silently missing row makes a span look complete when it is not,
 * which is the failure class this table exists to close.
 */
export async function recordConversationAdoption(
  db: PostgresJsDatabase,
  input: RecordConversationAdoptionInput
): Promise<"written" | "error"> {
  try {
    await db.insert(drivenSessionConversationsTable).values({
      localId: input.localId,
      harnessSessionId: input.harnessSessionId,
      harness: input.harness,
      driverGeneration: input.driverGeneration ?? 0,
      adoptionReason: input.adoptionReason,
      adoptedAt: new Date(),
    });
    return "written";
  } catch (err) {
    log.warn(
      `recordConversationAdoption: FAILED for ${input.localId} -> ${input.harnessSessionId} ` +
        `(reason=${input.adoptionReason}) — this session's conversation span now has a hole`,
      { error: getLoggableErrorSummary(err) }
    );
    return "error";
  }
}

/**
 * The ordered conversation span of one driven session — every conversation it
 * has adopted, oldest first.
 *
 * **The result is discriminated, not a bare array, and that is load-bearing.**
 * Returning `[]` on a read failure would be byte-identical to "this session
 * has adopted nothing," and those two call for opposite responses: the first
 * means retry or degrade visibly, the second means there is genuinely no
 * history. Collapsing them is how a lost span comes to look like an empty one
 * — the same shape as the defect this whole task closes, one layer up. Callers
 * must branch on `ok` before reading `conversationIds`.
 *
 * Ordered by `adopted_at`, then `seq`. The tiebreak matters because
 * `adopted_at` is a JS `Date` with MILLISECOND resolution and two adoptions on
 * one session can land inside a single tick, at which point the tiebreak alone
 * decides the span.
 *
 * It must be `seq`, never `id` (PR #3218 R1): `id` is `gen_random_uuid()`, so
 * ordering by it is arbitrary rather than insertion order — it would look like
 * a tiebreak while deciding ties at random. `seq` is
 * `GENERATED ALWAYS AS IDENTITY`, so it is monotonic in insertion order.
 */
export type ConversationSpanResult =
  | { ok: true; conversationIds: string[] }
  | { ok: false; error: string };

export async function resolveConversationIds(
  db: PostgresJsDatabase,
  localId: string
): Promise<ConversationSpanResult> {
  try {
    const result = await db.execute(
      sql`SELECT harness_session_id FROM driven_session_conversations
          WHERE local_id = ${localId}
          ORDER BY adopted_at ASC, seq ASC`
    );
    const rows = Array.from(result as Iterable<{ harness_session_id: string }>);
    return { ok: true, conversationIds: rows.map((r) => r.harness_session_id) };
  } catch (err) {
    const error = getLoggableErrorSummary(err);
    log.warn(`resolveConversationIds: failed for ${localId}`, { error });
    return { ok: false, error: String(error) };
  }
}

/**
 * The reasons that denote a FRESH spawn — i.e. a SWAP away from whatever
 * conversation the session was on. `initial` and `resumed` are the two that
 * are not: the first had no predecessor to replace, the second re-adopted the
 * predecessor rather than replacing it.
 */
const SWAP_REASONS: ReadonlySet<string> = new Set<AdoptionReason>([
  "no-prior-conversation",
  "prior-conversation-unrecoverable",
  "prior-spawn-never-linked",
  "resume-attempt-failed",
]);

/**
 * `entity_threads.replaced_conversation_id` as a PROJECTION over the adoption
 * series, superseding the stored column (mt#4323, criterion 5).
 *
 * The column was written directly by mt#4093 and is LAST-WRITE-WINS, so it
 * holds at most one swap back. This derives the same answer from the series:
 * find the newest SWAP adoption, and return the id of the adoption immediately
 * BEFORE it — the conversation that swap replaced.
 *
 * **Still one-deep, and deliberately so.** This is a back-compat projection of
 * a singular column, not the span; it answers "what did the last swap replace?"
 * and nothing more. Callers that want the thread's real history must call
 * {@link resolveConversationIds}, which is the whole point of the table —
 * every consumer that only ever needed one id keeps working unchanged, and the
 * ones that needed more finally have somewhere to get it.
 *
 * Returns `undefined` for a session that has never swapped. That is NOT the
 * same as a read failure, which throws to the caller — collapsing the two is
 * the exact confusion {@link ConversationSpanResult} exists to prevent.
 */
export async function resolveReplacedConversationId(
  db: PostgresJsDatabase,
  localId: string
): Promise<string | undefined> {
  const result = await db.execute(
    sql`SELECT harness_session_id, adoption_reason FROM driven_session_conversations
        WHERE local_id = ${localId}
        ORDER BY adopted_at ASC, seq ASC`
  );
  const rows = Array.from(
    result as Iterable<{ harness_session_id: string; adoption_reason: string }>
  );

  for (let i = rows.length - 1; i >= 1; i--) {
    const swap = rows[i];
    const predecessor = rows[i - 1];
    if (swap && predecessor && SWAP_REASONS.has(swap.adoption_reason)) {
      return predecessor.harness_session_id;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reads (raw SQL — see module docblock for why)
// ---------------------------------------------------------------------------

/** Shape of one raw row as returned by `postgres-js` (snake_case column names). */
interface RawDrivenSessionRow {
  local_id: string;
  harness_session_id: string | null;
  harness_kind: string;
  transport_id: string;
  harness_conversation_id: string | null;
  auth_mode: string;
  cwd: string;
  permission_mode: string;
  task_id: string | null;
  minsky_session_id: string | null;
  status: string;
  unrecoverable_reason: string | null;
  pid: number | null;
  pid_cmdline: string | null;
  model: string | null;
  driver_generation: number;
  started_at: Date | string;
  updated_at: Date | string;
}

/** Pure mapping — unit-tested directly, independent of any DB fake. */
export function mapRawDrivenSessionRow(raw: RawDrivenSessionRow): DrivenSessionRow {
  return {
    localId: raw.local_id,
    harnessSessionId: raw.harness_session_id,
    harnessKind: raw.harness_kind,
    transportId: raw.transport_id,
    harnessConversationId: raw.harness_conversation_id,
    authMode: raw.auth_mode,
    cwd: raw.cwd,
    permissionMode: raw.permission_mode,
    taskId: raw.task_id,
    minskySessionId: raw.minsky_session_id,
    status: raw.status,
    unrecoverableReason: raw.unrecoverable_reason,
    pid: raw.pid,
    pidCmdline: raw.pid_cmdline,
    model: raw.model,
    driverGeneration: raw.driver_generation,
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
    log.warn(`getDrivenSessionRecord: failed for ${localId}`, {
      error: getLoggableErrorSummary(err),
    });
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
    log.warn(`listNonTerminalDrivenSessions: failed`, { error: getLoggableErrorSummary(err) });
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
