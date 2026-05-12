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
// Core reader
// ---------------------------------------------------------------------------

/**
 * Read and aggregate metrics from a JSONL transcript.
 *
 * @param transcriptPath    Absolute path to the `.jsonl` transcript file.
 *                          When undefined, all metrics are returned as null.
 * @param agentSessionId    Harness-native session ID of the subagent.
 *                          When provided, only lines whose `agent_session_id`
 *                          matches are counted. When undefined, all lines are
 *                          counted.
 */
export async function readTranscriptMetrics(
  transcriptPath: string | undefined,
  agentSessionId: string | undefined
): Promise<TranscriptMetrics> {
  const nullResult: TranscriptMetrics = { toolUseCount: null, totalTokens: null, durationMs: null };

  if (!transcriptPath) {
    return nullResult;
  }

  try {
    if (!existsSync(transcriptPath)) {
      return nullResult;
    }

    const rawBuf = readFileSync(transcriptPath);
    const raw = rawBuf.toString();
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

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
