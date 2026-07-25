/**
 * Conversation run-state reads (mt#3201, mt#3130 Phase 2).
 *
 * The read half of the channel `repository.ts` writes. Kept separate from the
 * ingest path because the two have opposite hot paths: ingest is one upsert per
 * hook event fleet-wide, reads are per page view and per sweep tick.
 *
 * @see ./presence.ts — the pure derivation these rows feed
 * @see ./repository.ts — the write half
 */
import { and, desc, eq, lt, notInArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  conversationRunStateTable,
  type ConversationRunStateRecord,
} from "../storage/schemas/conversation-run-state-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { asksTable } from "../storage/schemas/ask-schema";
import { TERMINAL_ASK_STATES } from "../ask/state-machine";

/** Fetch one conversation's run-state row, or null when none exists. */
export async function getConversationRunState(
  db: PostgresJsDatabase,
  conversationId: string
): Promise<ConversationRunStateRecord | null> {
  const rows = await db
    .select()
    .from(conversationRunStateTable)
    .where(eq(conversationRunStateTable.conversationId, conversationId))
    .limit(1);
  return rows[0] ?? null;
}

/** The open Ask bound to a conversation, when one is resolvable. */
export interface LinkedOpenAsk {
  id: string;
  shortId: number | null;
  title: string;
  /** The workspace session the ask is actually keyed on — the hop that made the join possible. */
  minskySessionId: string;
}

/**
 * Resolve the open Ask for a conversation, if there is one.
 *
 * ## This is a two-hop join, not a direct edge
 *
 * `asks` carries only `parent_session_id` — a **workspace** session uuid. There
 * is no conversation-grain column on it. So the path is:
 *
 * ```
 * conversation_run_state.conversation_id
 *   -> minsky_session_links.agent_session_id
 *   -> minsky_session_links.minsky_session_id
 *   -> asks.parent_session_id
 * ```
 *
 * ## Coverage is partial BY CONSTRUCTION, and absence is not evidence
 *
 * `minsky_session_links.agent_session_id` has an FK to
 * `agent_transcripts.agent_session_id`, so a link row cannot exist until the
 * conversation has been INGESTED. A brand-new live conversation therefore has no
 * link yet. Measured 2026-07-24: only 4 of 15 tracked conversations (27%) had a
 * link row, against 98 of 236 workspaces (41.5%) linked overall.
 *
 * A null return therefore means **"no open Ask is resolvable for this
 * conversation"** — NEVER "this conversation has no open Ask". Callers must not
 * render the absence as a positive claim. The harness-native needs-input signal
 * (`needs_input_reason`, present on every hook-covered conversation) is the
 * primary source; this join is a best-effort enrichment that supplies the
 * `ask` reason variant and the deeplink target.
 *
 * "Open" is defined as NOT terminal, reusing {@link TERMINAL_ASK_STATES} — the
 * single exhaustive predicate in `ask/state-machine.ts` — rather than a second
 * hand-maintained list of open states, which is exactly the drift that file's
 * own `ALL_ASK_STATES_INDEX` guard exists to prevent.
 */
export async function findOpenAskForConversation(
  db: PostgresJsDatabase,
  conversationId: string
): Promise<LinkedOpenAsk | null> {
  const rows = await db
    .select({
      id: asksTable.id,
      shortId: asksTable.shortId,
      title: asksTable.title,
      minskySessionId: minskySessionLinksTable.minskySessionId,
    })
    .from(minskySessionLinksTable)
    .innerJoin(asksTable, eq(asksTable.parentSessionId, minskySessionLinksTable.minskySessionId))
    .where(
      and(
        eq(minskySessionLinksTable.agentSessionId, conversationId),
        notInArray(asksTable.state, TERMINAL_ASK_STATES as string[])
      )
    )
    .orderBy(desc(asksTable.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Conversations whose last observed event predates `olderThan` — the
 * absence-detection sweep's scan.
 *
 * Served by `idx_conversation_run_state_last_event_at`, which mt#3161 created
 * up front specifically for this query rather than after the table grew.
 */
export async function listConversationsQuietSince(
  db: PostgresJsDatabase,
  olderThan: Date,
  limit = 500
): Promise<ConversationRunStateRecord[]> {
  return db
    .select()
    .from(conversationRunStateTable)
    .where(lt(conversationRunStateTable.lastEventAt, olderThan))
    .orderBy(desc(conversationRunStateTable.lastEventAt))
    .limit(limit);
}
