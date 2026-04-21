/**
 * Authorship Provenance — public API
 *
 * @see mt#846 — Design: authorship semantics
 * @see mt#923 — Phase 1: provenance chain data model
 */

export { ProvenanceService, computePreliminaryTier } from "./provenance-service";
export {
  AuthorshipTier,
  type ArtifactType,
  type CreateProvenanceInput,
  type InitiationMode,
  type Participant,
  type ParticipantRole,
  type ProvenanceRecord,
  type SpecAuthorship,
  type TaskOrigin,
  type TierSignals,
} from "./types";
export {
  LABEL_HUMAN_AUTHORED,
  LABEL_CO_AUTHORED,
  LABEL_AGENT_AUTHORED,
  AUTHORSHIP_LABELS,
  tierToLabel,
  ensureAuthorshipLabelsExist,
  addAuthorshipLabel,
  buildMergeTrailers,
  type MergeIdentity,
} from "./authorship-labels";
export { TranscriptService, type TranscriptMessage, type MessageStats } from "./transcript-service";
