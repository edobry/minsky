/**
 * session-creator-link-writer — records which CONVERSATION created a
 * workspace session (mt#3120).
 *
 * `minsky_session_links` had a link-writer for the daemon-launched case
 * (`driven_spawn`, mt#2752) and the PR-authoring case (`pr_author`, mt#3101),
 * but no writer for the ordinary `session_start` case — the dominant path by
 * far. Measured 2026-07-23: 2 of 230 workspace sessions have ANY link row.
 *
 * WHY A HOOK HAS TO WRITE THIS. `startSessionImpl`
 * (`packages/domain/src/session/start-session-operations.ts`) runs inside the
 * MCP SERVER process, which is handed workspace-creation params and nothing
 * else — there is no conversation-id plumbing in the adapter layer, and the
 * server's own caller-identity resolution (`agent-identity/resolve.ts`,
 * mt#2292) cannot distinguish a parent conversation from its subagents (its
 * Layer-1 hash is stable per MCP-SERVER PROCESS, shared by all of them). Only
 * a Claude Code PostToolUse hook sees the calling conversation's own id, as
 * `input.session_id` — the same fact mt#3019, mt#3066, and mt#3101 all turned
 * on, and this module's caller (`stamp-session-creator-link.ts`) mirrors
 * `stamp-pr-author-link.ts` file-for-file for exactly that reason.
 *
 * The stub-then-link sequence below is NOT incidental: `agent_session_id`
 * carries a FOREIGN KEY to `agent_transcripts`, and at session-creation time
 * the creating conversation may not have been ingested yet — plausibly its
 * very FIRST tool call in a brand-new conversation. `driven-link-writer.ts`
 * and `pr-author-link-writer.ts` both solved the identical ordering problem
 * the same way (upsert a stub row the eventual full ingest fills in); this
 * module deliberately mirrors them rather than inventing a second approach.
 *
 * @see mt#3120 — this file
 * @see mt#3101 — pr-author-link-writer.ts, the sibling this file mirrors
 * @see mt#2752 — driven-link-writer.ts, the stub-then-link precedent both copy
 * @see conversation-link-resolver.ts — the read side (link-class agnostic;
 *   no reader change needed for this new class)
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { getErrorMessage } from "../errors/index";
import type { ConversationId } from "../ids";

/** Link-type value written by this module. */
export const SESSION_CREATOR_LINK_TYPE = "session_creator";

/**
 * Confidence 1.0: the harness told us this conversation made the
 * `session_start` call. This is an observed fact, not a heuristic match like
 * `cwd_match`'s 0.8.
 */
export const SESSION_CREATOR_CONFIDENCE = 1.0;

/**
 * Harness value for the stub row. Matches `driven-link-writer.ts` /
 * `pr-author-link-writer.ts`'s choice for the same reason: the eventual full
 * ingest keys its adapters off this column.
 */
const SESSION_CREATOR_STUB_HARNESS = "claude_code";

export interface SessionCreatorLinkInput {
  /** The harness conversation id that called `session_start`. */
  conversationId: ConversationId;
  /** The Minsky workspace session id `session_start` minted. */
  workspaceSessionId: string;
  /** The creating conversation's cwd — becomes the stub row's `cwd`. */
  cwd: string;
}

export type WriteSessionCreatorLinkOutcome = "written" | "error";

/**
 * Write the `session_creator` link for one workspace: upsert the
 * `agent_transcripts` stub row (FK target — see module docblock), then the
 * link row. Idempotent on both writes via `ON CONFLICT DO NOTHING`.
 *
 * Never throws — a DB failure is logged and swallowed so link-writing can
 * never disturb the session-creation call it rides alongside (structurally
 * guaranteed here too: PostToolUse fires strictly AFTER `session_start`
 * already returned successfully), matching the sibling writers' convention.
 */
export async function writeSessionCreatorLink(
  db: PostgresJsDatabase,
  input: SessionCreatorLinkInput
): Promise<WriteSessionCreatorLinkOutcome> {
  try {
    await db
      .insert(agentTranscriptsTable)
      .values({
        agentSessionId: input.conversationId,
        harness: SESSION_CREATOR_STUB_HARNESS,
        cwd: input.cwd,
      })
      .onConflictDoNothing();

    await db
      .insert(minskySessionLinksTable)
      .values({
        agentSessionId: input.conversationId,
        minskySessionId: input.workspaceSessionId,
        linkType: SESSION_CREATOR_LINK_TYPE,
        confidence: SESSION_CREATOR_CONFIDENCE,
      })
      .onConflictDoNothing();

    return "written";
  } catch (err) {
    log.warn(`writeSessionCreatorLink: failed for conversation ${input.conversationId}`, {
      error: getErrorMessage(err),
      minskySessionId: input.workspaceSessionId,
    });
    return "error";
  }
}
