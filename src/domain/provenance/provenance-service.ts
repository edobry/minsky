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
import { eq, and, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { provenanceTable } from "../storage/schemas/provenance-schema";
import {
  AuthorshipTier,
  type ArtifactType,
  type CreateProvenanceInput,
  type ProvenanceRecord,
  type TierSignals,
  type Participant,
  type RecomputeSummary,
} from "./types";
import {
  AUTHORSHIP_POLICY_VERSION,
  type AuthorshipJudgment,
  type AuthorshipJudge,
} from "./authorship-judge";
import type { TranscriptService } from "./transcript-service";
import { log } from "../../utils/logger";

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

  /**
   * Update a provenance record with AI-judged authorship fields.
   *
   * Called after AI-based transcript analysis completes (Phase 4).
   * Updates the tier, rationale, and structured analysis fields in place.
   */
  async updateWithJudgment(
    artifactId: string,
    artifactType: ArtifactType,
    judgment: AuthorshipJudgment
  ): Promise<void> {
    await this.db
      .update(provenanceTable)
      .set({
        substantiveHumanInput: judgment.substantiveHumanInput,
        trajectoryChanges: judgment.trajectoryChanges,
        authorshipTier: judgment.tier,
        tierRationale: judgment.rationale,
        judgingModel: "claude-haiku-4-5-20251001",
        policyVersion: AUTHORSHIP_POLICY_VERSION,
        computedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(provenanceTable.artifactId, artifactId),
          eq(provenanceTable.artifactType, artifactType)
        )
      );
  }

  /**
   * Retroactively recompute authorship tiers for all historical provenance records
   * that have a session_id, using the current judging policy.
   *
   * Records without a transcript are skipped (counted in skippedNoTranscript).
   * Each record is wrapped in try/catch so a single failure does not abort the batch.
   */
  async recomputeAll(options: {
    dryRun: boolean;
    judge: AuthorshipJudge;
    transcriptService: TranscriptService;
  }): Promise<RecomputeSummary> {
    const { dryRun, judge, transcriptService } = options;

    // Select all PR provenance records that have a session_id
    const records = await this.db
      .select()
      .from(provenanceTable)
      .where(and(eq(provenanceTable.artifactType, "pr"), isNotNull(provenanceTable.sessionId)));

    const summary: RecomputeSummary = {
      total: records.length,
      recomputed: 0,
      tierChanged: 0,
      skippedNoTranscript: 0,
      errors: 0,
      tierDistribution: {},
      changes: dryRun ? [] : undefined,
    };

    log.cli(`Recomputing tiers for ${records.length} provenance record(s)...`);

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      if (!row) continue;

      // Log progress every 10 records
      if (i > 0 && i % 10 === 0) {
        log.cli(`  Processed ${i}/${records.length} records...`);
      }

      const record = toProvenanceRecord(row);
      // sessionId is guaranteed non-null because the query filters isNotNull
      if (!record.sessionId) continue;
      const sessionId = record.sessionId;

      try {
        const transcript = await transcriptService.getTranscript(sessionId);

        if (!transcript) {
          summary.skippedNoTranscript++;
          continue;
        }

        const signals: TierSignals = {
          taskOrigin: record.taskOrigin ?? undefined,
          specAuthorship: record.specAuthorship ?? undefined,
          initiationMode: record.initiationMode ?? undefined,
        };

        const judgment = await judge.evaluateTranscript(transcript, signals);

        summary.recomputed++;
        const tierKey = String(judgment.tier);
        summary.tierDistribution[tierKey] = (summary.tierDistribution[tierKey] ?? 0) + 1;

        const oldTier = record.authorshipTier;
        if (oldTier !== judgment.tier) {
          summary.tierChanged++;
        }

        if (dryRun && summary.changes) {
          summary.changes.push({
            artifactId: record.artifactId,
            oldTier: oldTier,
            newTier: judgment.tier,
          });
        } else {
          await this.updateWithJudgment(record.artifactId, record.artifactType, judgment);
        }
      } catch (error) {
        summary.errors++;
        log.warn(`Failed to recompute tier for artifact ${record.artifactId}`, {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log.cli(
      `Recompute complete: ${summary.recomputed} recomputed, ` +
        `${summary.tierChanged} tier(s) changed, ` +
        `${summary.skippedNoTranscript} skipped (no transcript), ` +
        `${summary.errors} error(s).`
    );

    return summary;
  }
}
