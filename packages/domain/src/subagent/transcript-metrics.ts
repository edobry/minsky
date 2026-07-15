/**
 * Transcript metrics reader for subagent invocations.
 *
 * Reads a JSONL transcript file produced by the Claude Code harness and extracts
 * three metrics:
 *   - toolUseCount — number of tool_use blocks in the subagent's turn range
 *   - totalTokens  — sum of usage.input_tokens + usage.output_tokens across those turns
 *   - durationMs   — wall-clock duration from first to last message timestamp
 *
 * All metrics are nullable; they return null when:
 *   - transcript_path is undefined
 *   - the file is missing or unreadable
 *   - the file is malformed (non-JSON lines are skipped gracefully)
 *   - the relevant fields are absent from the transcript
 *
 * The function never throws.
 *
 * @see mt#1005 — Persist subagent execution history (parent epic)
 * @see mt#1737 — This file
 */

import { readFileSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscriptMetrics {
  /** Number of tool_use blocks across the subagent's turn range. Null when unavailable. */
  toolUseCount: number | null;
  /** Total token count (input + output) across the subagent's turn range. Null when unavailable. */
  totalTokens: number | null;
  /**
   * Wall-clock duration from first to last message timestamp in milliseconds.
   * Null when fewer than two messages have timestamps.
   */
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// JSONL line shapes (partial — only the fields we consume)
// ---------------------------------------------------------------------------

interface TranscriptMessageContent {
  type?: string;
}

interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface TranscriptLine {
  /** Session ID of the agent that produced this line. */
  agent_session_id?: string;
  /** ISO-8601 message timestamp (when available). */
  timestamp?: string;
  /** Message role. */
  role?: string;
  /** Message content (array of content blocks or string). */
  content?: TranscriptMessageContent[] | string;
  /** Token usage, typically on assistant messages. */
  usage?: TranscriptUsage;
  /** Type discriminator for some transcript formats. */
  type?: string;
}

// ---------------------------------------------------------------------------
// Shared line reader (mt#2796 R1 NON-BLOCKING)
// ---------------------------------------------------------------------------

/**
 * Read a transcript file's non-blank JSONL lines, once.
 *
 * Both {@link readTranscriptMetrics} and {@link extractActualModel} scan the
 * same on-disk file; previously each independently called `readFileSync` on
 * it, so a single SubagentStop-hook invocation read the (potentially large)
 * transcript twice. Callers that need both readers should call this once and
 * pass the result to each via their optional `preReadLines` parameter — see
 * `.minsky/hooks/record-subagent-invocation.ts`.
 *
 * Returns `null` on a missing file or any read error; never throws.
 */
export function readTranscriptLines(transcriptPath: string): string[] | null {
  try {
    if (!existsSync(transcriptPath)) {
      return null;
    }
    return readFileSync(transcriptPath)
      .toString()
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core reader
// ---------------------------------------------------------------------------

/**
 * Read and aggregate metrics from a JSONL transcript.
 *
 * @param transcriptPath    Absolute path to the `.jsonl` transcript file.
 *                          When undefined (and `preReadLines` is not
 *                          supplied), all metrics are returned as null.
 * @param agentSessionId    Harness-native session ID of the subagent.
 *                          When provided, only lines whose `agent_session_id`
 *                          matches are counted. When undefined, all lines are
 *                          counted.
 * @param preReadLines      Optional pre-split lines from {@link readTranscriptLines}.
 *                          When provided, `transcriptPath` is not read again —
 *                          pass this when a caller (e.g. the SubagentStop
 *                          hook) also calls {@link extractActualModel} on the
 *                          same file, to avoid reading it twice.
 */
export async function readTranscriptMetrics(
  transcriptPath: string | undefined,
  agentSessionId: string | undefined,
  preReadLines?: string[]
): Promise<TranscriptMetrics> {
  const nullResult: TranscriptMetrics = { toolUseCount: null, totalTokens: null, durationMs: null };

  if (!transcriptPath) {
    return nullResult;
  }

  try {
    const lines = preReadLines ?? readTranscriptLines(transcriptPath);
    if (!lines) {
      return nullResult;
    }

    let toolUseCount = 0;
    let totalTokens = 0;
    let firstTimestampMs: number | null = null;
    let lastTimestampMs: number | null = null;
    let hasAnyRelevantLine = false;

    for (const line of lines) {
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line) as TranscriptLine;
      } catch {
        // Skip malformed lines
        continue;
      }

      // Filter by agent session if provided
      if (agentSessionId != null && parsed.agent_session_id != null) {
        if (parsed.agent_session_id !== agentSessionId) {
          continue;
        }
      }

      hasAnyRelevantLine = true;

      // Track timestamps for durationMs
      if (parsed.timestamp) {
        const ts = new Date(parsed.timestamp).getTime();
        if (!isNaN(ts)) {
          if (firstTimestampMs === null || ts < firstTimestampMs) {
            firstTimestampMs = ts;
          }
          if (lastTimestampMs === null || ts > lastTimestampMs) {
            lastTimestampMs = ts;
          }
        }
      }

      // Count tool_use blocks in content
      if (Array.isArray(parsed.content)) {
        for (const block of parsed.content) {
          if (block?.type === "tool_use") {
            toolUseCount++;
          }
        }
      }

      // Sum token usage
      if (parsed.usage) {
        const inputToks = parsed.usage.input_tokens ?? 0;
        const outputToks = parsed.usage.output_tokens ?? 0;
        totalTokens += inputToks + outputToks;
      }
    }

    if (!hasAnyRelevantLine) {
      return nullResult;
    }

    const durationMs =
      firstTimestampMs !== null && lastTimestampMs !== null && lastTimestampMs > firstTimestampMs
        ? lastTimestampMs - firstTimestampMs
        : null;

    return {
      toolUseCount: toolUseCount > 0 ? toolUseCount : null,
      totalTokens: totalTokens > 0 ? totalTokens : null,
      durationMs,
    };
  } catch {
    // Fail-safe: return all-null on any unexpected error
    return nullResult;
  }
}

// ---------------------------------------------------------------------------
// Actual-model extraction (mt#2796)
// ---------------------------------------------------------------------------

/**
 * Harness-injected placeholder recorded as `message.model` on synthetic
 * assistant turns — rate-limit / API-error retries the harness manufactures
 * locally rather than a real model response. Never a genuine model id.
 * Verified 2026-07-15 against a real on-disk transcript.
 */
export const SYNTHETIC_MODEL_SENTINEL = "<synthetic>";

/**
 * Minimal shape of a real Claude Code transcript line, for the fields this
 * reader needs. Unlike {@link TranscriptLine} above (which assumes a flat
 * top-level shape), real transcripts nest message fields — including
 * `model` — under `message`:
 *
 * ```json
 * {"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5",...},...}
 * ```
 *
 * Per-agent subagent transcript files (`<session>/subagents/agent-<id>.jsonl`)
 * additionally carry a top-level `agentId` field identifying which agent
 * produced each line (verified against real on-disk fixtures 2026-07-15).
 * `agent_session_id` is kept as a secondary check for parity with the
 * top-level shape {@link readTranscriptMetrics} already looks for, in case a
 * caller passes a differently-shaped file.
 */
interface ModelTranscriptLine {
  type?: string;
  agentId?: string;
  agent_session_id?: string;
  message?: {
    model?: string;
  };
}

/**
 * Extract the first genuine (non-synthetic) model id from a JSONL
 * transcript's assistant-message lines.
 *
 * Scans `type: "assistant"` lines in file order and returns the first
 * `message.model` value that is a non-empty string and not the
 * {@link SYNTHETIC_MODEL_SENTINEL} placeholder. Returns `null` when no such
 * value exists (missing file, unreadable file, malformed JSON, no assistant
 * lines, or every assistant line is synthetic) — this function never throws.
 *
 * @param transcriptPath   Absolute path to the `.jsonl` transcript file.
 *                         When undefined (and `preReadLines` is not
 *                         supplied), returns null.
 * @param agentSessionId   Harness-native agent id of the subagent. When a
 *                         line carries an `agentId` or `agent_session_id`
 *                         field and it does not match, the line is skipped.
 *                         Lines with neither field present are always
 *                         considered (the common case: the resolved
 *                         transcript file is already scoped to one agent).
 * @param preReadLines     Optional pre-split lines from {@link readTranscriptLines}.
 *                         When provided, `transcriptPath` is not read again —
 *                         see {@link readTranscriptMetrics}'s matching parameter.
 */
export function extractActualModel(
  transcriptPath: string | undefined,
  agentSessionId: string | undefined,
  preReadLines?: string[]
): string | null {
  if (!transcriptPath) {
    return null;
  }

  try {
    const lines = preReadLines ?? readTranscriptLines(transcriptPath);
    if (!lines) {
      return null;
    }

    for (const line of lines) {
      let parsed: ModelTranscriptLine;
      try {
        parsed = JSON.parse(line) as ModelTranscriptLine;
      } catch {
        continue;
      }

      if (parsed.type !== "assistant") {
        continue;
      }

      if (agentSessionId != null) {
        const lineAgentId = parsed.agentId ?? parsed.agent_session_id;
        if (lineAgentId != null && lineAgentId !== agentSessionId) {
          continue;
        }
      }

      const model = parsed.message?.model;
      if (typeof model === "string" && model.length > 0 && model !== SYNTHETIC_MODEL_SENTINEL) {
        return model;
      }
    }

    return null;
  } catch {
    // Fail-safe: never throw, matching readTranscriptMetrics's contract.
    return null;
  }
}
