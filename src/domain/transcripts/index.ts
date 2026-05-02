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
