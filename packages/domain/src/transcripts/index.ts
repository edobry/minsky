/**
 * Harness-agnostic transcript-source domain layer.
 *
 * @see mt#1313 §Harness agnosticism
 * @see mt#1350 — TranscriptSource interface + ClaudeCodeTranscriptSource adapter
 */

export type {
  AgentSessionId,
  DiscoveredSession,
  RawTurnLine,
  TimestampISO,
  TranscriptSource,
} from "./transcript-source";
export {
  ClaudeCodeTranscriptSource,
  type ClaudeCodeTranscriptSourceOptions,
} from "./claude-code-transcript-source";
export {
  AgentTranscriptIngestService,
  type IngestAllResult,
} from "./agent-transcript-ingest-service";
export {
  extractTaskIds,
  extractPrNumbers,
  extractMetadata,
  extractMetadataFromJsonb,
  type TranscriptLine,
  type ExtractedMetadata,
} from "./metadata-extractor";
export {
  MetadataExtractionPipeline,
  type ExtractionPipelineResult,
} from "./metadata-extraction-pipeline";
// Transcript pipeline staging (ADR-019 / mt#2381): extraction (turn-writer) and
// the vector-only embedding backfill (per-turn-embedding-pipeline).
export {
  writeTurnsForTranscript,
  extractTurnsForAllTranscripts,
  type ExtractAllTurnsResult,
} from "./turn-writer";
export {
  PerTurnEmbeddingPipeline,
  type PipelineRunResult,
  type PerTurnEmbeddingPipelineOptions,
  type PerTurnEmbeddingRunOptions,
} from "./per-turn-embedding-pipeline";
// Conversation-element parser (mt#2374) — expands a SessionContextSnapshot
// block into ordered conversational sub-elements for the cockpit renderer.
export {
  snapshotBlockToConversationTurn,
  snapshotBlocksToConversation,
  spawnAgentKindFromInput,
  AGENT_TOOL_NAME,
  type ConversationElement,
  type ConversationRole,
  type ConversationTurn,
} from "./conversation-elements";
