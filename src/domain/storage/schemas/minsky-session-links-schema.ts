import { pgTable, text, real, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { agentTranscriptsTable } from "./agent-transcripts-schema";

/**
 * Minsky session links table — many-to-many between agent sessions and Minsky sessions.
 *
 * An agent session (e.g., a Claude Code conversation) may correspond to one or more
 * Minsky sessions (task-scoped work units). This table captures the detected linkage
 * with the method used to establish it and a confidence score.
 *
 * link_type values:
 *   - 'declared'      — the JSONL explicitly references the Minsky session ID
 *   - 'cwd_match'     — the agent session's cwd matches the Minsky session workspace
 *   - 'subagent_spawn' — the agent session was spawned by a parent whose Minsky link is known
 *   - 'merge_hook'    — the linkage was recorded at session_pr_merge time
 *
 * @see mt#1313 — Transcript search: harness-agnostic ingestion (§Minsky session links)
 * @see mt#1324 — Foundation schema migration
 */
export const minskySessionLinksTable = pgTable(
  "minsky_session_links",
  {
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentTranscriptsTable.agentSessionId),

    minskySessionId: text("minsky_session_id").notNull(),

    // How the link was established
    linkType: text("link_type").notNull(), // 'declared' | 'cwd_match' | 'subagent_spawn' | 'merge_hook'

    // Confidence in the linkage (0.0–1.0); exact matches are 1.0, heuristic matches < 1.0
    confidence: real("confidence"),

    // When the link was detected
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentSessionId, table.minskySessionId] })]
);
