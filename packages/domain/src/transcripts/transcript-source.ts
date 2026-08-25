/**
 * TranscriptSource: harness-agnostic interface for reading raw agent-session
 * transcripts. v1 implementation lives in `claude-code-transcript-source.ts`.
 *
 * @see mt#1313 §Harness agnosticism
 * @see mt#1350 — this file
 */

import type { ConversationId } from "../ids";

/** ISO-8601 timestamp string (e.g., "2026-04-22T17:59:56.633Z"). */
export type TimestampISO = string;

/**
 * Identifier of an agent session as known to its source harness.
 * Aliased to ConversationId (branded) so it is compile-time distinct from
 * WorkspaceId (Minsky session id). mt#2524.
 */
export type AgentSessionId = ConversationId;

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
  /**
   * Session working directory if recoverable from the source; absent
   * otherwise. Sources should populate from harness-recorded metadata
   * (e.g. Claude Code records `cwd` on each user turn). When absent,
   * downstream consumers leave `agent_transcripts.cwd` NULL rather than
   * substituting the JSONL path. mt#1445.
   */
  cwd?: string;
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
  /**
   * Stream retention-filtered raw turn lines for one session.
   *
   * `jsonlPath` is the session's already-known file path — pass it whenever the
   * caller holds a `DiscoveredSession`. Without it a discovery-backed source has
   * to resolve the id by scanning, which is O(all transcripts) per call and made
   * `ingestAll` quadratic in corpus size (mt#3288). Omit it only for a genuine
   * id-only lookup where no path is available.
   */
  readSession(agentSessionId: AgentSessionId, jsonlPath?: string): AsyncIterable<RawTurnLine>;
  /**
   * Stream EVERY line for one session, in file order, with NO retention filter
   * (mt#4573).
   *
   * `readSession` above yields only the types a source chooses to retain, and
   * that choice is lossy in a way no downstream consumer can undo: for Claude
   * Code the dropped set is ~24% of lines and is exactly the un-timestamped
   * ones, so a timestamp-keyed reader cannot even observe that they are
   * missing. This method is what `transcript_lines` captures from, and it is
   * the only path by which a `.jsonl` can be reconstructed faithfully enough
   * for the harness to resume the conversation.
   *
   * Implementations MUST yield in file order and MUST NOT filter by type. A
   * line that cannot be parsed is skipped (it is unstorable as `jsonb`), and so
   * consumes no ordinal.
   */
  readSessionRaw(agentSessionId: AgentSessionId, jsonlPath?: string): AsyncIterable<RawTurnLine>;
  /**
   * Does this line pass the source's own retention filter — i.e. would
   * `readSession` have yielded it (mt#4573)?
   *
   * Exposed so a caller iterating `readSessionRaw` can drive BOTH destinations
   * from one read: capture every line, and apply the legacy retained-only logic
   * to the subset, without hard-coding a harness's type set at the call site.
   */
  isRetainedLine(line: RawTurnLine): boolean;
  /** Extract the ISO timestamp from a raw line; undefined if missing/invalid. */
  getJsonlTimestamp(line: RawTurnLine): TimestampISO | undefined;
}

/**
 * Is this a SIDECAR line — yielded for side-channel analysis, never stored?
 *
 * `readSession` yields two populations. Most lines are CONTENT: they become a
 * `transcript` entry or an `agent_transcript_attachments` row, and each one
 * consumes a `lineIndex`. A sidecar line is neither; it exists so a reader can
 * observe something the stored projection cannot express — currently only
 * `last-prompt`, whose two-leaves-on-different-branches shape is the only
 * writer-identity trace the transcript format offers (mem#805, mt#3656).
 *
 * **Why this is a shared predicate and not a per-caller check.** `lineIndex` is
 * half of the attachments primary key, so two writers that disagree about which
 * lines are countable produce colliding keys for the same file. There are
 * exactly two such writers — `AgentTranscriptIngestService.ingestSession` and
 * `scripts/backfill-agent-transcript-attachments.ts` — and mt#3836 exists
 * because a change to the yielded set was made without them agreeing. Adding a
 * type here is therefore a decision about BOTH, made in one place.
 *
 * A function rather than an exported `Set`: the retained-type sets are
 * deliberately per-source module constants (`custom/no-domain-singleton`), and
 * this stays consistent with that by exporting behavior, not mutable state.
 */
export const SIDECAR_LINE_TYPES = ["last-prompt"] as const;

export function isSidecarLineType(line: RawTurnLine): boolean {
  return SIDECAR_LINE_TYPES.includes(line.type as (typeof SIDECAR_LINE_TYPES)[number]);
}
