/**
 * Authorship Provenance Types
 *
 * Domain types for the three-tier authorship model. Provenance records track
 * the causal chain from task → session → artifact, with observable signals
 * that feed into tier computation.
 *
 * @see mt#846 — Design: authorship semantics for bot-identity operations
 * @see mt#923 — Phase 1: provenance chain data model
 */

/** Authorship tier — determines git author, trailers, and PR labels. */
export enum AuthorshipTier {
  /** Human provided substantial direction and design. */
  HUMAN_AUTHORED = 1,
  /** Mixed contribution — both human and agent shaped the outcome. */
  CO_AUTHORED = 2,
  /** Agent-initiated with minimal human involvement. */
  AGENT_AUTHORED = 3,
}

/** Role a participant played in producing the artifact. */
export type ParticipantRole = "director" | "implementer" | "reviewer" | "approver";

/** How the work was initiated. */
export type InitiationMode = "dispatched" | "autonomous" | "interactive";

/** Who created the originating task. */
export type TaskOrigin = "human" | "agent" | "automated";

/** Who authored the task spec. */
export type SpecAuthorship = "human" | "agent" | "mixed";

/** Exhaustive list of artifact types — derive the TS union and Zod enum from this single source. */
export const ARTIFACT_TYPES = ["commit", "pr", "review", "issue_comment"] as const;

/** Type of artifact tracked by provenance. */
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** A participant in the artifact's creation. */
export interface Participant {
  identity: string;
  role: ParticipantRole;
}

/** Full provenance record as stored in the database. */
export interface ProvenanceRecord {
  id: string;
  artifactId: string;
  artifactType: ArtifactType;
  taskId: string | null;
  sessionId: string | null;
  transcriptId: string | null;
  taskOrigin: TaskOrigin | null;
  specAuthorship: SpecAuthorship | null;
  initiationMode: InitiationMode | null;
  humanMessages: number;
  totalMessages: number;
  corrections: number;
  participants: Participant[];
  substantiveHumanInput: string | null;
  trajectoryChanges: unknown | null;
  authorshipTier: AuthorshipTier | null;
  tierRationale: string | null;
  policyVersion: string;
  judgingModel: string | null;
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a provenance record — computed fields omitted. */
export interface CreateProvenanceInput {
  artifactId: string;
  artifactType: ArtifactType;
  taskId?: string;
  sessionId?: string;
  taskOrigin?: TaskOrigin;
  specAuthorship?: SpecAuthorship;
  initiationMode?: InitiationMode;
  humanMessages?: number;
  totalMessages?: number;
  corrections?: number;
  participants?: Participant[];
}

/** Signals used for preliminary tier computation. */
export interface TierSignals {
  taskOrigin?: TaskOrigin;
  specAuthorship?: SpecAuthorship;
  initiationMode?: InitiationMode;
}

/** Summary returned by ProvenanceService.recomputeAll(). */
export interface RecomputeSummary {
  total: number;
  recomputed: number;
  tierChanged: number;
  skippedNoTranscript: number;
  errors: number;
  /** Distribution of final tiers: "1" | "2" | "3" → count */
  tierDistribution: Record<string, number>;
  /** Only populated in dry-run mode. */
  changes?: Array<{ artifactId: string; oldTier: number | null; newTier: number }>;
}
