import { pgTable, text, real, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
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
 *   - 'driven_spawn'  — the session was launched by the cockpit as a driven child
 *   - 'pr_author'     — the conversation that called `session_pr_create` for this workspace
 *   - 'session_creator' — the conversation that called `session_start` and had it minted
 *   - 'merge_hook'    — the linkage was recorded at session_pr_merge time
 *
 * NOTE (mt#3101): `declared` and `merge_hook` are DESIGN-ONLY — specified by
 * mt#1313 and never implemented. Zero writers exist for either, and the live
 * table has never held a row of either type. `pr_author` is the one that
 * actually covers the "a hook records the linkage" case they described; it is
 * deliberately at PR-create time rather than merge time, because the
 * authorship-relevant conversation is the one that WROTE the code (for
 * dispatched work the implementer creates the PR and the main agent merges).
 *
 * NOTE (mt#3120): `session_creator` is the same hook-based mechanism as
 * `pr_author` (PostToolUse reads `input.session_id` + the tool's result), just
 * for `session_start` instead of `session_pr_create` — it is the writer for
 * the DOMINANT creation path the table had none for until this task. Measured
 * 2026-07-23: 2 of 230 workspace sessions had any link row at all.
 *
 * @see mt#1313 — Transcript search: harness-agnostic ingestion (§Minsky session links)
 * @see mt#1324 — Foundation schema migration
 * @see mt#3101 — `pr_author`, and the id-space defect it closes
 * @see mt#3120 — `session_creator`
 */
export const minskySessionLinksTable = pgTable(
  "minsky_session_links",
  {
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentTranscriptsTable.agentSessionId),

    minskySessionId: text("minsky_session_id").notNull(),

    // How the link was established
    linkType: text("link_type").notNull(), // 'declared' | 'cwd_match' | 'subagent_spawn' | 'driven_spawn' | 'pr_author' | 'session_creator' | 'merge_hook'

    // Confidence in the linkage (0.0–1.0); exact matches are 1.0, heuristic matches < 1.0
    confidence: real("confidence"),

    // When the link was detected
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentSessionId, table.minskySessionId] }),
    // mt#2767 (latency follow-up) — the composite PK above only covers
    // lookups keyed by agentSessionId (the leading column); the unified
    // run-list merge's forward-direction query
    // (`WHERE minsky_session_id IN (...)`, resolving each VISIBLE
    // workspace's best-linked conversation) filters on the second column
    // alone, which the PK cannot serve — a full-table scan on every poll.
    // Live-measured regression: unified /api/widget/agents/data warm at
    // 2-9s vs. the pre-merge baseline's 0.33s (2026-07-14).
    index("idx_minsky_session_links_minsky_session_id").on(table.minskySessionId),
  ]
);
