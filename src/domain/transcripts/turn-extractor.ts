/**
 * TurnExtractor — pure function that walks `agent_transcripts.transcript` JSONB,
 * groups (user, assistant) message pairs into per-turn rows with stable
 * `turn_index` ordering, and marks spawn-boundary turns.
 *
 * A "turn" is a (user, assistant) message pair. The user message provides the
 * prompt; the assistant message provides the response, possibly including tool
 * calls. A spawn-boundary turn is one where the assistant message contains a
 * `tool_use` content block with `name === "Agent"`.
 *
 * For spawn-boundary turns, the tool-result payload carried in the SUBSEQUENT
 * user message (as `tool_result` content blocks) is excluded from
 * `assistant_text`. Only the spawn instruction (the `tool_use` block's input)
 * is retained. This prevents 2x storage of subagent content.
 *
 * @see mt#1313 §Schema, §Subagent dedup
 * @see mt#1352 — this file
 */

import type { RawTurnLine } from "./transcript-source";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single content block from the Anthropic messages format. */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

/** One extracted turn row — maps 1:1 to agent_transcript_turns. */
export interface ExtractedTurn {
  turnIndex: number;
  userText: string | null;
  assistantText: string | null;
  toolCalls: ContentBlock[] | null;
  startedAt: Date | null;
  endedAt: Date | null;
  isSpawnBoundary: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise a message's `content` field into an array of ContentBlock objects.
 * Claude Code stores content as either a plain string or an array of blocks.
 */
function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter(
      (item): item is ContentBlock => typeof item === "object" && item !== null
    );
  }
  return [];
}

/**
 * Extract the assistant-facing text from a list of content blocks.
 * - `text` blocks are concatenated.
 * - `thinking` blocks are omitted (internal CoT, not relevant for search).
 * - `tool_use` blocks are omitted from the text (captured separately as toolCalls).
 */
function extractAssistantText(blocks: ContentBlock[]): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Extract the user-facing text from a list of content blocks.
 * - `text` blocks are concatenated (like the initial human prompt).
 * - `tool_result` blocks are intentionally excluded — they carry tool output
 *   which is already captured in prior assistant turns or in the subagent
 *   transcript (for spawn-boundary turns).
 */
function extractUserText(blocks: ContentBlock[]): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Extract `tool_use` blocks from the assistant message. These represent
 * tool invocations made during the turn.
 */
function extractToolCalls(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((b) => b.type === "tool_use");
}

/**
 * Returns true if any of the content blocks is a `tool_use` with name === "Agent".
 * This is the spawn-boundary signal: the assistant delegated work to a subagent.
 */
function hasAgentToolCall(toolCalls: ContentBlock[]): boolean {
  return toolCalls.some((b) => b.type === "tool_use" && b.name === "Agent");
}

/**
 * Parse an ISO timestamp string into a Date object; returns null on failure.
 */
function parseTimestamp(ts: unknown): Date | null {
  if (typeof ts !== "string") return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

// ── Core extraction ───────────────────────────────────────────────────────────

/**
 * Walk a `transcript` JSONB array (array of RawTurnLine) and return one
 * ExtractedTurn per (user, assistant) pair. Turn ordering follows the natural
 * order of the lines (stable turn_index starts at 0).
 *
 * Pairing algorithm:
 * - Iterate lines in order.
 * - When a `user` line is encountered, start a new pending turn.
 * - When an `assistant` line is encountered after a pending user line, close
 *   the turn and emit it.
 * - Consecutive user lines overwrite the pending turn (the last user line wins).
 * - Consecutive assistant lines are accumulated into a single assistant message
 *   (some harnesses emit continuation assistant lines; see §Streaming).
 * - A trailing user line with no following assistant line is emitted as a
 *   partial turn (assistantText = null).
 *
 * @param transcript - Array of raw turn lines from agent_transcripts.transcript.
 * @returns Ordered array of ExtractedTurn rows.
 */
export function extractTurns(transcript: RawTurnLine[]): ExtractedTurn[] {
  const turns: ExtractedTurn[] = [];
  let turnIndex = 0;

  // Pending state for the current turn being assembled.
  let pendingUserText: string | null = null;
  let pendingUserStartedAt: Date | null = null;
  let pendingAssistantBlocks: ContentBlock[] = [];
  let pendingAssistantEndedAt: Date | null = null;
  let hasPendingUser = false;
  let hasPendingAssistant = false;

  function flushTurn(): void {
    if (!hasPendingUser && !hasPendingAssistant) return;

    const toolCalls = extractToolCalls(pendingAssistantBlocks);
    const isSpawnBoundary = hasAgentToolCall(toolCalls);

    // For spawn-boundary turns, assistant_text only contains the text blocks
    // (the spawn instruction prompt). tool_use blocks for Agent calls are
    // captured in toolCalls; the subagent transcript content is excluded.
    const assistantText = hasPendingAssistant ? extractAssistantText(pendingAssistantBlocks) : null;

    turns.push({
      turnIndex,
      userText: pendingUserText,
      assistantText,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      startedAt: pendingUserStartedAt,
      endedAt: pendingAssistantEndedAt ?? pendingUserStartedAt,
      isSpawnBoundary,
    });

    turnIndex++;

    // Reset pending state.
    pendingUserText = null;
    pendingUserStartedAt = null;
    pendingAssistantBlocks = [];
    pendingAssistantEndedAt = null;
    hasPendingUser = false;
    hasPendingAssistant = false;
  }

  for (const line of transcript) {
    if (line.type === "user") {
      if (hasPendingUser && hasPendingAssistant) {
        // We have a complete (user, assistant) pair — flush before starting a new user.
        flushTurn();
      }
      // If we have a pending user but no assistant, we overwrite it with the new user line
      // (back-to-back user lines; the last one wins).

      const msg = line.message as Record<string, unknown> | undefined;
      const content = msg?.["content"];
      const blocks = normalizeContent(content);
      const text = extractUserText(blocks);

      pendingUserText = text;
      pendingUserStartedAt = parseTimestamp(line.timestamp);
      hasPendingUser = true;
    } else if (line.type === "assistant") {
      // Accumulate assistant blocks (streaming or split messages).
      const msg = line.message as Record<string, unknown> | undefined;
      const content = msg?.["content"];
      const blocks = normalizeContent(content);
      pendingAssistantBlocks.push(...blocks);

      pendingAssistantEndedAt = parseTimestamp(line.timestamp);
      hasPendingAssistant = true;

      // If there is no pending user, treat this assistant-only line as a partial turn.
      // Flush immediately so that subsequent user lines start a fresh pair.
      if (!hasPendingUser) {
        flushTurn();
      }
    }
  }

  // Flush any trailing turn (e.g., a user message with no following assistant).
  if (hasPendingUser || hasPendingAssistant) {
    flushTurn();
  }

  return turns;
}
