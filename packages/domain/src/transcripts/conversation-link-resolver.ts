/**
 * conversation-link-resolver — workspace session id -> authoring conversation
 * id, via `minsky_session_links` (mt#3101).
 *
 * This is the READ side of the id-space bridge. It replaces
 * `unresolvedWorkspaceIdAsConversationId`, the mt#3066 stopgap that re-labelled
 * a workspace id and logged that the lookup would miss; that module is deleted
 * with this one's arrival.
 *
 * DIRECTION MATTERS. The existing readers of this table
 * (`transcript-list-service.ts`, `src/cockpit/routes/conversations.ts`) all
 * query the FORWARD direction — given conversations, find their workspaces —
 * and filter on `agent_session_id`, the leading column of the composite PK.
 * This resolver runs the REVERSE query, filtering on `minsky_session_id`
 * alone, which the PK cannot serve; it relies on
 * `idx_minsky_session_links_minsky_session_id`, added by mt#2767 for exactly
 * this filter shape after the unindexed version was measured at 2-9s per poll.
 *
 * ANY link type resolves. A workspace's conversation is the same conversation
 * regardless of how the linkage was detected, so `pr_author`, `driven_spawn`,
 * `subagent_spawn` and `cwd_match` are all valid evidence. Ordering by
 * confidence prefers observed links (1.0) over heuristic ones (`cwd_match`'s
 * 0.8 descendant match); `detected_at` breaks ties toward the most recent.
 *
 * @see mt#3101 — this file
 * @see pr-author-link-writer.ts — the write side
 * @see mt#3066 — the id-space defect and the seam typing this preserves
 */

import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { getErrorMessage } from "../errors/index";
import type { ConversationId, WorkspaceId } from "../ids";
import type { AgentTranscriptService } from "../provenance/transcript-service";

/**
 * Resolve the conversation that authored work in the given workspace session,
 * or `null` when no link has been recorded for it.
 *
 * `null` is a legitimate outcome, not an error: a workspace whose PR predates
 * the `pr_author` writer, or one created outside the hook path, simply has no
 * link. Callers MUST distinguish that from "the transcript was empty" in their
 * logging — collapsing the two is the exact defect mt#3066 and mt#3101 fix
 * (`work-completion.mdc §Invocation path`, never-swallow-into-nothing).
 *
 * Never throws — a DB failure is logged and returns `null`, matching the
 * best-effort posture of the link writers. The log line names the failure so a
 * DB error is distinguishable from an absent link.
 */
export async function resolveConversationForWorkspace(
  db: PostgresJsDatabase,
  workspaceSessionId: string
): Promise<ConversationId | null> {
  try {
    const rows = await db
      .select({ agentSessionId: minskySessionLinksTable.agentSessionId })
      .from(minskySessionLinksTable)
      .where(
        and(
          eq(minskySessionLinksTable.minskySessionId, workspaceSessionId),
          isNotNull(minskySessionLinksTable.agentSessionId)
        )
      )
      .orderBy(desc(minskySessionLinksTable.confidence), desc(minskySessionLinksTable.detectedAt))
      .limit(1);

    const best = rows[0]?.agentSessionId;
    return best ? (best as ConversationId) : null;
  } catch (err) {
    log.warn(
      `resolveConversationForWorkspace: link lookup FAILED for workspace ${workspaceSessionId} — ` +
        "this is a database error, not an absent link",
      { error: getErrorMessage(err) }
    );
    return null;
  }
}

// ── Compile-time contract lock (mt#3066, relocated here by mt#3101) ──────────
//
// The durable guarantee mt#3066 landed is that `getTranscript`'s parameter is a
// branded `ConversationId`, so a workspace id cannot be passed without a
// compile error. These assertions are that guarantee's only enforcement, and
// they moved here when `unresolved-conversation-id.ts` was deleted.
//
// They live in a SOURCE module, not a `*.test.ts` file, because
// `packages/**/*.test.ts` is in no typecheck program: the root `tsconfig.json`
// `include` is `["src", "types", "tests", ...]`, and files under `packages/`
// enter the program only by being imported from `src/`. Nothing imports a test
// file, so a `@ts-expect-error` written in one is never evaluated — verified by
// negative control during mt#3066, and tracked as mt#3102. This module IS
// imported by `provenance-service.ts`, which `src/` reaches, so the assertions
// below are checked on every `validate_typecheck` run.
//
// Negative control (re-run whenever this block is touched): widening the
// parameter back to `string` must produce TS2344 here in all three workspaces.

type FirstParameter<T> = T extends (first: infer P, ...rest: never[]) => unknown ? P : never;

type TranscriptLookupKey = FirstParameter<AgentTranscriptService["getTranscript"]>;

type AssertTrue<T extends true> = T;

/** A `WorkspaceId` must NOT satisfy the transcript lookup key. */
type _WorkspaceIdIsRejected = AssertTrue<WorkspaceId extends TranscriptLookupKey ? false : true>;

/** A plain `string` must NOT satisfy it either (the pre-mt#3066 signature). */
type _PlainStringIsRejected = AssertTrue<string extends TranscriptLookupKey ? false : true>;

/** A `ConversationId` must satisfy it. */
type _ConversationIdIsAccepted = AssertTrue<
  ConversationId extends TranscriptLookupKey ? true : false
>;
