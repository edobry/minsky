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
// minsky_session_links `cwd_match` writer + backfill (mt#2441).
export {
  detectCwdMatch,
  writeCwdMatchLink,
  backfillCwdMatchLinks,
  CWD_MATCH_LINK_TYPE,
  CWD_MATCH_EXACT_CONFIDENCE,
  CWD_MATCH_DESCENDANT_CONFIDENCE,
  type CwdMatchDetection,
  type BackfillCwdMatchLinksResult,
} from "./session-link-writer";
// minsky_session_links `subagent_spawn` writer + backfill (mt#2756).
export {
  extractMinskySessionIdFromPrompt,
  writeSpawnLink,
  backfillSpawnLinks,
  SUBAGENT_SPAWN_LINK_TYPE,
  SUBAGENT_SPAWN_CONFIDENCE,
  type BackfillSpawnLinksResult,
} from "./spawn-link-writer";
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
