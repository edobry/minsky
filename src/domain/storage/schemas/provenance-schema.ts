import { pgTable, text, uuid, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";

/**
 * Provenance table — authorship provenance chain records for Minsky-managed artifacts.
 *
 * Every commit, PR, or review created by Minsky gets an associated provenance record
 * linking it to its task, session, and authorship signals. The preliminary authorship
 * tier is computed from static signals at creation time; AI-judged fields are populated
 * later (Phase 4).
 *
 * Conventions followed:
 * - UUID PK (same as task_relationships)
 * - No FK constraints — task_id/session_id are plain text refs per project convention
 * - jsonb for structured metadata (participants, trajectory_changes)
 * - withTimezone on all timestamps
 */
export const provenanceTable = pgTable(
  "provenance",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Artifact identity
    artifactId: text("artifact_id").notNull(), // commit SHA, PR number, review ID
    artifactType: text("artifact_type").notNull(), // 'commit' | 'pr' | 'review' | 'issue_comment'

    // Causal chain (plain text refs, no FKs per convention)
    taskId: text("task_id"), // originating task (nullable for taskless sessions)
    sessionId: text("session_id"), // Minsky session ID
    transcriptId: text("transcript_id"), // references agent_transcripts(agent_session_id)

    // Static signals
    taskOrigin: text("task_origin"), // 'human' | 'agent' | 'automated'
    specAuthorship: text("spec_authorship"), // 'human' | 'agent' | 'mixed'
    initiationMode: text("initiation_mode"), // 'dispatched' | 'autonomous' | 'interactive'
    humanMessages: integer("human_messages").default(0),
    totalMessages: integer("total_messages").default(0),
    corrections: integer("corrections").default(0),

    // Participants: [{identity: string, role: ParticipantRole}]
    participants: jsonb("participants").default([]),

    // AI-judged fields (populated in Phase 4, nullable for now)
    substantiveHumanInput: text("substantive_human_input"),
    trajectoryChanges: jsonb("trajectory_changes"),

    // Tier
    authorshipTier: integer("authorship_tier"), // 1 | 2 | 3
    tierRationale: text("tier_rationale"),

    // Audit
    policyVersion: text("policy_version").default("1.0.0"),
    judgingModel: text("judging_model"),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    byArtifact: index("idx_provenance_artifact").on(table.artifactId, table.artifactType),
    bySession: index("idx_provenance_session").on(table.sessionId),
    byTask: index("idx_provenance_task").on(table.taskId),
  })
);
