/**
 * driven-link-writer — populates `minsky_session_links` with `driven_spawn`
 * links (mt#2752, Rung 2C of the harness-host ladder).
 *
 * Sibling of `session-link-writer.ts` (mt#2441's `cwd_match` class) and
 * `spawn-link-writer.ts` (mt#2756's `subagent_spawn` class): writes to the
 * SAME `minsky_session_links` table via the same PK/upsert convention — a
 * third link class, not a parallel table or consumer contract. Readers
 * (`pickBestConversationLink`, routes/agents.ts, run-merge.ts) are
 * link-class agnostic, so this class is consumed with zero reader changes.
 *
 * The signal here is stronger than either sibling's: the cockpit daemon
 * SPAWNED the harness process itself (driven-session-host.ts), so both sides
 * of the link are first-party facts, not inferences — the workspace sessionId
 * was chosen at launch time, and the harness session id arrives on the
 * child's own `system/init` event. Confidence is 1.0 and there is no
 * heuristic tier.
 *
 * FK ordering constraint (load-bearing): `minsky_session_links
 * .agent_session_id` references `agent_transcripts.agent_session_id`, and at
 * init-event time the transcript has NOT been ingested yet (the child only
 * just started). {@link writeDrivenSpawnLink} therefore upserts a minimal
 * `agent_transcripts` stub row FIRST (harness/cwd/started_at — the
 * insert-only fields), then the link row. This is safe with the later full
 * ingest: `AgentTranscriptIngestService.ingestSession` uses
 * `INSERT … ON CONFLICT (agent_session_id) DO UPDATE` restricted to
 * non-insert-only fields, so the stub is UPDATED in place, never skipped and
 * never duplicated.
 *
 * @see mt#1313 / mt#1324 — minsky_session_links schema
 * @see mt#2441 / session-link-writer.ts — the `cwd_match` sibling
 * @see mt#2756 / spawn-link-writer.ts — the `subagent_spawn` sibling
 * @see mt#2752 — this file; src/cockpit/driven-session-launch.ts is the caller
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
import type { ConversationId } from "../ids";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { getErrorMessage } from "../errors/index";

/** Link-type value written by this module (mt#2752's `driven_spawn` class). */
export const DRIVEN_SPAWN_LINK_TYPE = "driven_spawn";

/**
 * Confidence assigned to a driven-spawn link. Both ids are first-party facts
 * observed by the daemon that spawned the process — there is no heuristic
 * tier (see module docblock), so every link gets 1.0.
 */
export const DRIVEN_SPAWN_CONFIDENCE = 1.0;

/** Harness discriminator for the stub transcript row — the driven-session
 * host spawns the genuine Claude Code binary, so the eventual full ingest
 * (which keys adapters off this column) sees the value it expects. */
export const DRIVEN_STUB_HARNESS = "claude_code";

export interface DrivenSpawnLinkInput {
  /** The harness session id from the child's `system/init` event. */
  agentSessionId: string;
  /** The Minsky workspace sessionId the session was launched against. */
  minskySessionId: string;
  /** The child's cwd (the workspace directory for task-bound sessions). */
  cwd: string;
  /** Spawn time (ISO-8601) — becomes the stub row's `started_at`. */
  startedAt: string;
}

export type WriteDrivenSpawnLinkOutcome = "written" | "error";

/**
 * Write the `driven_spawn` link for one app-started driven session: upsert
 * the `agent_transcripts` stub row (FK target — see module docblock), then
 * the link row. Idempotent on both writes via `ON CONFLICT DO NOTHING`
 * against each table's primary key.
 *
 * Never throws — a DB failure is logged and swallowed so link-writing can
 * never disturb the running driven session it rides alongside, matching the
 * sibling writers' error-swallowing convention.
 */
export async function writeDrivenSpawnLink(
  db: PostgresJsDatabase,
  input: DrivenSpawnLinkInput
): Promise<WriteDrivenSpawnLinkOutcome> {
  try {
    await db
      .insert(agentTranscriptsTable)
      .values({
        agentSessionId: input.agentSessionId as ConversationId,
        harness: DRIVEN_STUB_HARNESS,
        cwd: input.cwd,
        startedAt: new Date(input.startedAt),
      })
      .onConflictDoNothing();

    await db
      .insert(minskySessionLinksTable)
      .values({
        agentSessionId: input.agentSessionId,
        minskySessionId: input.minskySessionId,
        linkType: DRIVEN_SPAWN_LINK_TYPE,
        confidence: DRIVEN_SPAWN_CONFIDENCE,
      })
      .onConflictDoNothing();

    return "written";
  } catch (err) {
    log.warn(`writeDrivenSpawnLink: failed for session ${input.agentSessionId}`, {
      error: getErrorMessage(err),
      minskySessionId: input.minskySessionId,
    });
    return "error";
  }
}
