/**
 * pr-author-link-writer — records which CONVERSATION authored a session PR
 * (mt#3101).
 *
 * `provenance.session_id` holds a Minsky WORKSPACE session id, but every
 * transcript lookup keys on the harness CONVERSATION id. Measured 2026-07-23:
 * 0 of 1,305 provenance rows resolve, and merge-time AI authorship-tier
 * judging has run exactly once as a result. mt#3066 fixed the sibling instance
 * in a hook; this module supplies the missing mapping for the provenance side.
 *
 * WHY A HOOK HAS TO WRITE THIS. The provenance row is created by
 * `session-pr-operations.ts`, inside the MCP SERVER process, which is handed a
 * workspace id and nothing else — there is no conversation-id plumbing in the
 * adapter layer, and the only session identifier the server holds is the MCP
 * transport session id, a third id space (ADR-022). Only a hook sees the
 * conversation id, as `input.session_id`.
 *
 * WHY PR-CREATE TIME, NOT MERGE TIME. The authorship-relevant conversation is
 * the one that WROTE the code, which is the one that called
 * `session_pr_create`. For dispatched work those differ: an implementer
 * subagent creates the PR and the main agent merges it, so stamping at merge
 * time would attribute the main agent's transcript to the subagent's work.
 * (`minsky_session_links`' schema comment documents a `merge_hook` link type
 * for "recorded at session_pr_merge time" — never implemented, and the wrong
 * moment for this purpose.)
 *
 * The stub-then-link sequence below is NOT incidental: `agent_session_id`
 * carries a FOREIGN KEY to `agent_transcripts`, and at PR-create time the
 * authoring conversation is still in flight and may not have been ingested
 * yet. `driven-link-writer.ts` solved the identical ordering problem the same
 * way (upsert a stub row the eventual full ingest fills in), and this module
 * deliberately mirrors it rather than inventing a second approach.
 *
 * @see mt#3101 — this file
 * @see mt#3066 — the sibling id-space fix, and the caller audit that found this
 * @see driven-link-writer.ts — the stub-then-link precedent this copies
 * @see conversation-link-resolver.ts — the read side
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { getLoggableErrorSummary } from "../errors/index";
import type { ConversationId } from "../ids";

/** Link-type value written by this module. */
export const PR_AUTHOR_LINK_TYPE = "pr_author";

/**
 * Confidence 1.0: the harness told us this conversation made the call. This is
 * an observed fact, not a heuristic match like `cwd_match`'s 0.8.
 */
export const PR_AUTHOR_CONFIDENCE = 1.0;

/**
 * Harness value for the stub row. Matches `driven-link-writer.ts`'s choice for
 * the same reason: the eventual full ingest keys its adapters off this column.
 */
const PR_AUTHOR_STUB_HARNESS = "claude_code";

export interface PrAuthorLinkInput {
  /** The harness conversation id that called `session_pr_create`. */
  conversationId: ConversationId;
  /** The Minsky workspace session id the PR was created for. */
  workspaceSessionId: string;
  /** The authoring conversation's cwd — becomes the stub row's `cwd`. */
  cwd: string;
}

export type WritePrAuthorLinkOutcome = "written" | "error";

/**
 * Write the `pr_author` link for one session PR: upsert the
 * `agent_transcripts` stub row (FK target — see module docblock), then the
 * link row. Idempotent on both writes via `ON CONFLICT DO NOTHING`.
 *
 * EXPECTED TO BE RARE IN THE DATA, and that is not a defect. The table's
 * primary key is `(agent_session_id, minsky_session_id)`, so if that pair
 * already carries a link — which it usually does for dispatched work, via
 * `subagent_spawn` or `driven_spawn` — this insert is a silent no-op and the
 * existing link stands. Resolution is unaffected (same pair, same mapping), so
 * a low `pr_author` row count means the siblings got there first, NOT that
 * this writer is dead. mt#3066 Finding B is the incident where exactly this
 * shadowing was misread as a dead writer; do not re-open that investigation.
 *
 * Never throws — a DB failure is logged and swallowed so link-writing can
 * never disturb the PR creation it rides alongside, matching the sibling
 * writers' convention.
 */
export async function writePrAuthorLink(
  db: PostgresJsDatabase,
  input: PrAuthorLinkInput
): Promise<WritePrAuthorLinkOutcome> {
  try {
    await db
      .insert(agentTranscriptsTable)
      .values({
        agentSessionId: input.conversationId,
        harness: PR_AUTHOR_STUB_HARNESS,
        cwd: input.cwd,
      })
      .onConflictDoNothing();

    await db
      .insert(minskySessionLinksTable)
      .values({
        agentSessionId: input.conversationId,
        minskySessionId: input.workspaceSessionId,
        linkType: PR_AUTHOR_LINK_TYPE,
        confidence: PR_AUTHOR_CONFIDENCE,
      })
      .onConflictDoNothing();

    return "written";
  } catch (err) {
    log.warn(`writePrAuthorLink: failed for conversation ${input.conversationId}`, {
      error: getLoggableErrorSummary(err),
      minskySessionId: input.workspaceSessionId,
    });
    return "error";
  }
}
