/**
 * Restoring entity-thread replies from the harness transcript (mt#4073).
 *
 * ## The failure this closes
 *
 * A reply whose append fails goes to the in-memory buffer in
 * ./entity-thread-reply-buffer.ts, which reconciles it back when the store
 * recovers. That buffer is process memory: a daemon restart drops it, and
 * because the GET route omits `pendingReplies` when the buffer is empty, the
 * operator's "1 reply could not be saved yet" notice disappears at the same
 * moment. The thread is left with a hole and nothing saying so.
 *
 * The reply itself survives. The same driven session's output is ALSO ingested
 * into `agent_transcript_turns` by the cockpit's transcript-watcher, which tails
 * a JSONL file written by the child process — not by the daemon — so it outlives
 * the restart that loses the buffer. This module reads that ingest and appends
 * back what the thread is missing.
 *
 * ## Reconciler, not a queue
 *
 * The recorder stays the fast path; these rows are durable incremental state; a
 * sweeper closes the difference. That is the house default rather than a local
 * invention — ADR-017 §Context, on this very ingest path: "don't depend on
 * cooperative shutdown; depend on durable incremental state plus reconciliation."
 * A daemon restart is exactly the uncooperative shutdown it means. Nothing new
 * is written at buffer time, so no write-ahead log appears in front of the table
 * that is supposed to BE the record.
 *
 * The decision logic — which turns are missing, and the containment matching
 * that makes that safe — lives in
 * `@minsky/domain/transcripts/entity-thread-reconcile` as pure functions. This
 * module is only the IO around it.
 *
 * @see mt#4073 — this module
 * @see ./entity-thread-reply-buffer.ts — the in-memory half, for a store that is merely down
 * @see ../../packages/domain/src/transcripts/entity-thread-reconcile.ts — the decision core
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  appendEntityThreadTurn,
  listEntityThreadTurns,
  type EntityThreadTurn,
} from "@minsky/domain/transcripts/entity-thread-store";
import {
  selectRecoverableTurns,
  type TranscriptAssistantTurn,
} from "@minsky/domain/transcripts/entity-thread-reconcile";
import { resolveConversationIds } from "@minsky/domain/transcripts/driven-session-registry-store";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";

export interface ThreadReconcileOutcome {
  /** Turns appended back onto the thread this pass. */
  recovered: number;
  /** Conversations the thread's history was searched across. */
  conversationsConsidered: number;
  /**
   * True when the thread has no conversation to search at all, so a gap — if
   * there is one — cannot be closed by this mechanism. Distinct from
   * `recovered: 0`, which also covers the healthy "nothing was missing" case.
   */
  unresolvable: boolean;
}

const EMPTY_OUTCOME: ThreadReconcileOutcome = {
  recovered: 0,
  conversationsConsidered: 0,
  unresolvable: true,
};

/**
 * Every conversation this thread's history could be spread across.
 *
 * **This function is the seam**, and as of mt#4323 the open question it was
 * written against is closed: ADR-044 was accepted, and
 * `driven_session_conversations` — the append-only adoption series — is now
 * the authoritative source for a thread's span. The one-swap-back bound this
 * docblock used to record as an unfixable coverage limit is GONE for any swap
 * recorded after that table shipped.
 *
 * **Why the legacy columns are still read, rather than replaced.** The table
 * is not backfilled (mt#4323 `## Scope` — rows lost to the overwriting upsert
 * are already gone). But two ids that predate it are NOT gone: the CURRENT
 * `driven_sessions.harness_session_id` and the one-deep
 * `entity_threads.replaced_conversation_id`. Switching to the table alone
 * would therefore have discarded live information and REGRESSED recovery for
 * every thread that existed before the migration, until it happened to adopt
 * again. So this unions the series with the two columns and dedupes: strictly
 * a superset of both the old behaviour and the new, converging on the series
 * alone as pre-migration sessions age out.
 *
 * A failed series read is a degraded read, not an empty span — the union keeps
 * whatever the columns can still answer rather than reporting nothing.
 */
export async function resolveThreadConversationIds(
  db: PostgresJsDatabase,
  localId: string
): Promise<string[]> {
  const ids: string[] = [];
  const push = (raw: string | null | undefined): void => {
    const id = raw?.trim();
    if (id && !ids.includes(id)) ids.push(id);
  };

  // Authoritative: the adoption series (ADR-044), oldest first.
  const span = await resolveConversationIds(db, localId);
  if (span.ok) {
    for (const id of span.conversationIds) push(id);
  } else {
    log.warn(
      `entity-thread reconcile: adoption series unreadable for ${localId}, ` +
        `falling back to the legacy columns alone`,
      { error: span.error }
    );
  }

  // Back-compat: the two ids that exist for pre-migration sessions.
  const current = await db.execute(sql`
    SELECT harness_session_id FROM driven_sessions WHERE local_id = ${localId}
  `);
  for (const row of Array.from(current as Iterable<{ harness_session_id?: string | null }>)) {
    push(row.harness_session_id);
  }

  const replaced = await db.execute(sql`
    SELECT replaced_conversation_id FROM entity_threads WHERE local_id = ${localId}
  `);
  for (const row of Array.from(
    replaced as Iterable<{ replaced_conversation_id?: string | null }>
  )) {
    push(row.replaced_conversation_id);
  }

  return ids;
}

/** Ingested assistant turns for one conversation. */
async function readTranscriptAssistantTurns(
  db: PostgresJsDatabase,
  conversationId: string
): Promise<TranscriptAssistantTurn[]> {
  const result = await db.execute(sql`
    SELECT turn_index, assistant_text, ended_at
    FROM agent_transcript_turns
    WHERE agent_session_id = ${conversationId}
      AND assistant_text IS NOT NULL
    ORDER BY turn_index ASC
  `);

  const turns: TranscriptAssistantTurn[] = [];
  for (const row of Array.from(
    result as Iterable<{
      turn_index: number | string;
      assistant_text: string | null;
      ended_at: Date | string | null;
    }>
  )) {
    const text = row.assistant_text;
    if (!text) continue;
    // A turn with no instant cannot be placed against the window, and defaulting
    // it would either strand a real reply or admit one from before the thread.
    // Dropping it is the honest option — the same discipline
    // `blocksToStoredAgentReplies` follows for an unparsable block timestamp.
    if (!row.ended_at) continue;
    const endedAt = row.ended_at instanceof Date ? row.ended_at : new Date(row.ended_at);
    const endedAtMs = endedAt.getTime();
    if (Number.isNaN(endedAtMs)) continue;
    turns.push({
      conversationId,
      turnIndex:
        typeof row.turn_index === "string" ? Number.parseInt(row.turn_index, 10) : row.turn_index,
      text,
      endedAtMs,
    });
  }
  return turns;
}

function agentTurnsOf(turns: EntityThreadTurn[]): { content: string; createdAtMs: number }[] {
  return turns
    .filter((turn) => turn.role === "agent")
    .map((turn) => ({
      content: turn.content,
      // For an already-recovered turn the ORIGINAL instant is the watermark —
      // `createdAt` is when the reconciler wrote it, which would push the window
      // forward past replies that are still missing.
      createdAtMs: (turn.originallySentAt ?? turn.createdAt).getTime(),
    }));
}

/**
 * The store operations one reconcile pass needs.
 *
 * Injected rather than imported-and-called, following the sibling buffer's
 * `EntityThreadTurnStore` and for the same reason its docblock gives: handing
 * the pass a failing store is the only way to observe what it does under one,
 * and the alternative — patching module imports — is design feedback rather
 * than a test technique (`testing-standards.mdc §Testable Design`). It is also
 * the only way to exercise a thread whose transcript holds a reply the table is
 * missing, which no real Postgres will produce on demand.
 */
export interface ThreadReconcileStore {
  resolveConversationIds(db: PostgresJsDatabase, localId: string): Promise<string[]>;
  readTranscriptTurns(
    db: PostgresJsDatabase,
    conversationId: string
  ): Promise<TranscriptAssistantTurn[]>;
  listTurns(db: PostgresJsDatabase, localId: string): Promise<EntityThreadTurn[]>;
  /** When the thread row itself was created — the window's fallback anchor. */
  readThreadStartedAtMs(db: PostgresJsDatabase, localId: string): Promise<number | undefined>;
  appendTurn(
    db: PostgresJsDatabase,
    input: {
      localId: string;
      role: "operator" | "agent";
      content: string;
      recoveredFromConversationId?: string;
      originallySentAt?: Date;
    }
  ): Promise<EntityThreadTurn>;
}

/**
 * When the thread row was created (PR #2971 R1).
 *
 * The window's fallback anchor has to come from the THREAD, not from its first
 * turn. Anchoring on `turns[0]` leaves a thread with ZERO stored turns with no
 * anchor at all, so nothing is eligible and the first missing reply can never be
 * recovered — which is precisely the case where every reply is missing and
 * recovery matters most. That state is reachable: the operator's own message is
 * written through the same failing append path as the agent's.
 */
async function readThreadStartedAtMs(
  db: PostgresJsDatabase,
  localId: string
): Promise<number | undefined> {
  const result = await db.execute(sql`
    SELECT created_at FROM entity_threads WHERE local_id = ${localId}
  `);
  for (const row of Array.from(result as Iterable<{ created_at?: Date | string | null }>)) {
    const createdAt = row.created_at;
    if (!createdAt) continue;
    const ms = (createdAt instanceof Date ? createdAt : new Date(createdAt)).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

const PRODUCTION_STORE: ThreadReconcileStore = {
  resolveConversationIds: resolveThreadConversationIds,
  readTranscriptTurns: readTranscriptAssistantTurns,
  listTurns: listEntityThreadTurns,
  readThreadStartedAtMs,
  appendTurn: appendEntityThreadTurn,
};

/**
 * One reconcile pass over a thread.
 *
 * Never throws. This runs at daemon boot and off the drain chain, where the
 * sibling convention (see ./entity-thread-launch.ts's recorder) is that
 * persistence work must never disturb the daemon; a reconcile that cannot read
 * is the degraded case this exists for, not an error to raise.
 */
export async function reconcileThreadFromTranscript(
  db: PostgresJsDatabase,
  localId: string,
  store: ThreadReconcileStore = PRODUCTION_STORE
): Promise<ThreadReconcileOutcome> {
  try {
    const conversationIds = await store.resolveConversationIds(db, localId);
    if (conversationIds.length === 0) return { ...EMPTY_OUTCOME };

    const storedTurns = await store.listTurns(db, localId);
    const storedAgentTurns = agentTurnsOf(storedTurns);
    // The THREAD's creation instant, not its first turn's — a thread with zero
    // turns still has a start, and that is the case where every reply is missing
    // (PR #2971 R1). Falls back to the first turn only if the thread row cannot
    // be read, which keeps a partial answer rather than none.
    const threadStartedAtMs =
      (await store.readThreadStartedAtMs(db, localId)) ?? storedTurns[0]?.createdAt.getTime();

    const transcriptTurns: TranscriptAssistantTurn[] = [];
    for (const conversationId of conversationIds) {
      transcriptTurns.push(...(await store.readTranscriptTurns(db, conversationId)));
    }

    const missing = selectRecoverableTurns({
      storedAgentTurns,
      transcriptTurns,
      ...(threadStartedAtMs === undefined ? {} : { threadStartedAtMs }),
    });

    let recovered = 0;
    for (const turn of missing) {
      await store.appendTurn(db, {
        localId,
        role: "agent",
        content: turn.text,
        recoveredFromConversationId: turn.conversationId,
        originallySentAt: new Date(turn.endedAtMs),
      });
      recovered++;
    }

    if (recovered > 0) {
      log.info(
        `entity-thread reconcile: restored ${recovered} reply(ies) for ${localId} from ${conversationIds.length} conversation(s)`
      );
    }

    return { recovered, conversationsConsidered: conversationIds.length, unresolvable: false };
  } catch (err) {
    log.warn(`entity-thread reconcile: pass failed for ${localId}`, {
      error: getLoggableErrorSummary(err),
    });
    return { ...EMPTY_OUTCOME };
  }
}

/**
 * How many threads one boot pass will reconcile.
 *
 * A bound on work at startup, not a policy. Measured against prod 2026-08-13
 * there are 8 entity threads total, so this is ~25x headroom; a deployment that
 * ever exceeds it wants a cursor rather than a bigger number, and the log line
 * below names what was skipped rather than truncating silently.
 */
export const BOOT_RECONCILE_THREAD_LIMIT = 200;

/**
 * Reconcile every entity thread once, at daemon start.
 *
 * **Boot is the right trigger, not a convenient one.** The failure this closes
 * runs: an append fails, the reply is buffered in memory, the daemon restarts,
 * and the buffer dies with it. The very next thing that happens is this boot —
 * so the pass that recovers the reply is the one immediately following the
 * restart that lost it. Waiting for the operator to open the panel would leave
 * the gap on screen for however long that takes.
 *
 * Never throws, for the same reason the per-thread pass does not: this is armed
 * fire-and-forget from route mounting, where an unhandled rejection is a
 * boot-time crash.
 */
export async function reconcileAllThreadsFromTranscript(
  db: PostgresJsDatabase
): Promise<{ threadsScanned: number; recovered: number }> {
  try {
    const result = await db.execute(sql`
      SELECT local_id FROM entity_threads
      ORDER BY updated_at DESC
      LIMIT ${BOOT_RECONCILE_THREAD_LIMIT + 1}
    `);
    const localIds = Array.from(result as Iterable<{ local_id: string }>).map(
      (row) => row.local_id
    );

    if (localIds.length > BOOT_RECONCILE_THREAD_LIMIT) {
      log.warn(
        `entity-thread reconcile: ${localIds.length - BOOT_RECONCILE_THREAD_LIMIT}+ thread(s) beyond the boot limit of ${BOOT_RECONCILE_THREAD_LIMIT} were NOT scanned`
      );
      localIds.length = BOOT_RECONCILE_THREAD_LIMIT;
    }

    let recovered = 0;
    for (const localId of localIds) {
      const outcome = await reconcileThreadFromTranscript(db, localId);
      recovered += outcome.recovered;
    }

    // Say what happened on EVERY boot, including the zero case — the same
    // discipline mt#4103 applied to boot reconciliation next door, where a
    // silent happy path made "it ran and found nothing" indistinguishable from
    // "it never ran at all."
    log.info(
      `entity-thread reconcile: scanned ${localIds.length} thread(s) at boot, restored ${recovered} reply(ies)`
    );
    return { threadsScanned: localIds.length, recovered };
  } catch (err) {
    log.warn("entity-thread reconcile: boot pass failed", {
      error: getLoggableErrorSummary(err),
    });
    return { threadsScanned: 0, recovered: 0 };
  }
}
