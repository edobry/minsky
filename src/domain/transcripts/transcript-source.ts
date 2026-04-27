/**
 * TranscriptSource: harness-agnostic interface for reading raw agent-session
 * transcripts. v1 implementation lives in `claude-code-transcript-source.ts`.
 *
 * @see mt#1313 §Harness agnosticism
 * @see mt#1350 — this file
 */

/** ISO-8601 timestamp string (e.g., "2026-04-22T17:59:56.633Z"). */
export type TimestampISO = string;

/** Identifier of an agent session as known to its source harness. */
export type AgentSessionId = string;

/** A raw JSONL line that survived the harness-specific retention filter. */
export interface RawTurnLine {
  /** Filtered to retained types (e.g., "user" | "assistant" for Claude Code). */
  type: string;
  /** Inner message payload, harness-specific shape. */
  message?: unknown;
  /** ISO timestamp from the line, when present. */
  timestamp?: TimestampISO;
  /** Stable per-line identifier, when the harness emits one. */
  uuid?: string;
  /** Pass-through fields from the harness JSONL (cwd, gitBranch, etc.). */
  [key: string]: unknown;
}

/** A discovered transcript file ready to be read. */
export interface DiscoveredSession {
  agentSessionId: AgentSessionId;
  /** Absolute path to the JSONL file. */
  jsonlPath: string;
  /** Source harness label (e.g., "claude_code"). */
  harness: string;
  /** True when the file is a subagent transcript under `<parent>/subagents/`. */
  isSubagent: boolean;
  /** Last modified time; consumers use it for incremental ingest decisions. */
  mtime: Date;
}

/**
 * Source adapter for agent-session transcripts. v1 = Claude Code; future
 * adapters (Cursor, Minsky-native interpreter) implement the same interface.
 * Pure read-only: no DB writes, no MCP wiring.
 */
export interface TranscriptSource {
  /** Harness label, matches `DiscoveredSession.harness`. */
  readonly harness: string;
  /** Enumerate transcript files known to this source. */
  discoverSessions(): AsyncIterable<DiscoveredSession>;
  /** Stream retention-filtered raw turn lines for one session. */
  readSession(agentSessionId: AgentSessionId): AsyncIterable<RawTurnLine>;
  /** Extract the ISO timestamp from a raw line; undefined if missing/invalid. */
  getJsonlTimestamp(line: RawTurnLine): TimestampISO | undefined;
}
