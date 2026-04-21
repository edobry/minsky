/**
 * Provenance Service
 *
 * CRUD operations for authorship provenance records. Tracks the causal chain
 * from task → session → artifact and computes preliminary authorship tiers
 * from static signals.
 *
 * The preliminary tier is a heuristic from observable signals (task origin,
 * spec authorship, initiation mode). The final tier (Phase 4) will use
 * AI-based transcript analysis.
 *
 * @see mt#923 — Phase 1: provenance chain data model
 */

import { injectable } from "tsyringe";
import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { provenanceTable } from "../storage/schemas/provenance-schema";
import {
  AuthorshipTier,
  type ArtifactType,
  type CreateProvenanceInput,
  type ProvenanceRecord,
  type TierSignals,
  type Participant,
} from "./types";

/** Maps a DB row to a typed ProvenanceRecord. */
function toProvenanceRecord(row: typeof provenanceTable.$inferSelect): ProvenanceRecord {
  return {
    id: row.id,
    artifactId: row.artifactId,
    artifactType: row.artifactType as ArtifactType,
    taskId: row.taskId,
    sessionId: row.sessionId,
    transcriptId: row.transcriptId,
    taskOrigin: row.taskOrigin as ProvenanceRecord["taskOrigin"],
    specAuthorship: row.specAuthorship as ProvenanceRecord["specAuthorship"],
    initiationMode: row.initiationMode as ProvenanceRecord["initiationMode"],
    humanMessages: row.humanMessages ?? 0,
    totalMessages: row.totalMessages ?? 0,
    corrections: row.corrections ?? 0,
    participants: (row.participants ?? []) as Participant[],
    substantiveHumanInput: row.substantiveHumanInput,
    trajectoryChanges: row.trajectoryChanges,
    authorshipTier: row.authorshipTier as AuthorshipTier | null,
    tierRationale: row.tierRationale,
    policyVersion: row.policyVersion ?? "1.0.0",
    judgingModel: row.judgingModel,
    computedAt: row.computedAt ?? new Date(),
    createdAt: row.createdAt ?? new Date(),
    updatedAt: row.updatedAt ?? new Date(),
  };
}

/**
 * Compute a preliminary authorship tier from static signals.
 *
 * Heuristic:
 * - Agent-originated + autonomous → Tier 3 (agent-authored)
 * - Human-originated + human-authored spec → Tier 1 (human-authored)
 * - Everything else → Tier 2 (co-authored, the honest middle ground)
 */
export function computePreliminaryTier(signals: TierSignals): AuthorshipTier {
  if (signals.taskOrigin === "agent" && signals.initiationMode === "autonomous") {
    return AuthorshipTier.AGENT_AUTHORED;
  }
  if (signals.taskOrigin === "human" && signals.specAuthorship === "human") {
    return AuthorshipTier.HUMAN_AUTHORED;
  }
  return AuthorshipTier.CO_AUTHORED;
}

@injectable()
export class ProvenanceService {
  constructor(private readonly db: PostgresJsDatabase) {}

  /** Create a provenance record with a preliminary tier computed from static signals. */
  async createProvenanceRecord(input: CreateProvenanceInput): Promise<ProvenanceRecord> {
    const tier = computePreliminaryTier({
      taskOrigin: input.taskOrigin,
      specAuthorship: input.specAuthorship,
      initiationMode: input.initiationMode,
    });

    const tierRationale = `Preliminary tier from static signals: task_origin=${input.taskOrigin ?? "unknown"}, spec_authorship=${input.specAuthorship ?? "unknown"}, initiation_mode=${input.initiationMode ?? "unknown"}`;

    const rows = await this.db
      .insert(provenanceTable)
      .values({
        artifactId: input.artifactId,
        artifactType: input.artifactType,
        taskId: input.taskId ?? null,
        sessionId: input.sessionId ?? null,
        taskOrigin: input.taskOrigin ?? null,
        specAuthorship: input.specAuthorship ?? null,
        initiationMode: input.initiationMode ?? null,
        humanMessages: input.humanMessages ?? 0,
        totalMessages: input.totalMessages ?? 0,
        corrections: input.corrections ?? 0,
        participants: (input.participants ?? []) as Participant[],
        authorshipTier: tier,
        tierRationale,
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error("Failed to insert provenance record — no row returned");
    }
    return toProvenanceRecord(row);
  }

  /** Look up provenance for a specific artifact. */
  async getProvenanceForArtifact(
    artifactId: string,
    artifactType: ArtifactType
  ): Promise<ProvenanceRecord | null> {
    const rows = await this.db
      .select()
      .from(provenanceTable)
      .where(
        and(
          eq(provenanceTable.artifactId, artifactId),
          eq(provenanceTable.artifactType, artifactType)
        )
      )
      .limit(1);

    const row = rows[0];
    return row ? toProvenanceRecord(row) : null;
  }

  /** Get all provenance records for a session. */
  async getProvenanceForSession(sessionId: string): Promise<ProvenanceRecord[]> {
    const rows = await this.db
      .select()
      .from(provenanceTable)
      .where(eq(provenanceTable.sessionId, sessionId));

    return rows.map(toProvenanceRecord);
  }

  /** Get all provenance records linked to a task. */
  async getProvenanceForTask(taskId: string): Promise<ProvenanceRecord[]> {
    const rows = await this.db
      .select()
      .from(provenanceTable)
      .where(eq(provenanceTable.taskId, taskId));

    return rows.map(toProvenanceRecord);
  }
}
