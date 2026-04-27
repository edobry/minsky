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
