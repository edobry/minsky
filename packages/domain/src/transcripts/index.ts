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
  fetchTranscriptPage,
  DEFAULT_EXTRACT_ALL_BATCH_SIZE,
  type ExtractAllTurnsResult,
  type ExtractAllTurnsOptions,
  type WriteTurnsResult,
  type TranscriptPageRow,
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
  type WriteSpawnLinkOutcome,
  type BackfillSpawnLinksResult,
} from "./spawn-link-writer";
// Shared Agent-tool-call JSONB shape + finder (mt#2756 R1) — used by both
// AgentSpawnsPipeline and spawn-link-writer.ts to avoid drift.
export { findAgentToolCall, type AgentToolCallBlock } from "./agent-tool-call-shape";
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
// Watchable-world semantic event schema v0 + transcript adapter + Gource
// exporter (mt#3157, Phase 0 of the watchable-world program).
export {
  EVENT_SCHEMA_VERSION,
  EVENT_VERBS,
  DEFAULT_VERB_WEIGHTS,
  weightForVerb,
  PATH_BEARING_VERBS,
  isPathBearingVerb,
  EVENT_ACTOR_KINDS,
  EVENT_OUTCOMES,
  EVENT_REALMS,
  type EventSchemaVersion,
  type EventVerb,
  type EventActorKind,
  type EventActor,
  type EventOutcome,
  type EventRealm,
  type EventTarget,
  type SemanticEvent,
} from "./event-schema";
export {
  adaptTranscriptToEvents,
  computeAdapterCoverage,
  ADAPTER_VERSION,
  type AdapterContext,
  type AdapterCoverageResult,
  type ToolResultInfo,
} from "./event-adapter";
export {
  eventsToGourceLines,
  formatGourceLog,
  exportGourceLog,
  assertScrubGate,
  UnscrubbedSessionError,
  CREDENTIAL_SCRUB_CUTOFF_ISO,
  type GourceAction,
  type GourceLogLine,
  type ExportGourceLogOptions,
} from "./gource-exporter";
