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
 * Claude Code-synthesized markers recorded as a `user`-role line whose sole
 * content is one of these exact strings — NOT actual human input, but a
 * harness-internal event marking that the user cancelled an in-flight
 * response/tool call (mt#3131 D6). Left un-excluded, this line starts (or
 * silently clobbers) a pending turn like any other "user" line, corrupting
 * turn-count aggregates with a synthetic non-prompt. Present in 73/165
 * sampled transcripts (44%) per the mt#3131 investigation.
 *
 * Mirrors `.minsky/hooks/transcript.ts`'s `SYNTHETIC_INTERRUPT_MARKERS`
 * (mt#2824, a harness-hook-side discovery of the same two literal variants) —
 * duplicated rather than imported because that file lives outside
 * `packages/domain` in a separate hook-script bundling context, matching the
 * existing precedent of `RETAINED_TYPES` being deliberately non-shared
 * (see `single-file-transcript-source.ts`).
 */
const SYNTHETIC_INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
]);

/** True iff a `user` line's raw message content is EXACTLY one synthetic interrupt marker. */
function isSyntheticInterruptLine(blocks: ContentBlock[]): boolean {
  if (blocks.length !== 1) return false;
  const block = blocks[0];
  return (
    block?.type === "text" &&
    typeof block.text === "string" &&
    SYNTHETIC_INTERRUPT_MARKERS.has(block.text.trim())
  );
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

/**
 * The Anthropic Messages API `id` of the model message this line carries, when
 * the harness recorded one.
 *
 * This is the fusion discriminator (mt#3883). ONE model turn can reach the JSONL
 * as several consecutive `assistant` lines — those share a `message.id` and must
 * accumulate into one extracted turn. TWO distinct model turns carry DIFFERENT
 * ids and must not be fused, even with no intervening `user` line to separate
 * them.
 *
 * Deliberately NOT `parentUuid`: the tree answers a different question (which
 * sibling branch superseded which), which is mt#3975's half of the original
 * mt#3514 split. `message.id` is both cheaper and the correct discriminator for
 * this one.
 */
function extractMessageId(line: RawTurnLine): string | null {
  const msg = line.message as Record<string, unknown> | undefined;
  const id = msg?.["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Does an incoming assistant line continue the model turn already pending?
 *
 * A missing id on EITHER side answers "yes". Measured over 120 transcripts
 * (37,781 assistant lines), a DIFFERING id marks a real turn boundary 46 times
 * against 18,485 same-id continuations — but an ABSENT id carries no such
 * signal, and treating absence as a boundary would manufacture turn splits out
 * of missing data. Fail toward the pre-mt#3883 behavior (accumulate), so a line
 * shape the harness never labels is left exactly as it was.
 */
function continuesPendingModelTurn(pendingId: string | null, incomingId: string | null): boolean {
  if (pendingId === null || incomingId === null) return true;
  return pendingId === incomingId;
}

// ── Core extraction ───────────────────────────────────────────────────────────

/**
 * Walk a `transcript` JSONB array (array of RawTurnLine) and return one
 * ExtractedTurn per (user, assistant) pair. Turn ordering follows the natural
 * order of the lines (stable turn_index starts at 0).
 *
 * Pairing algorithm:
 * - Iterate lines in order.
 * - When a `user` line is encountered, flush any pending turn, then start a new
 *   pending turn.
 * - Consecutive user lines overwrite the pending turn (the last user line wins).
 *   That is the ingest-side supersession behavior; making it a DELIBERATE,
 *   documented policy rather than an emergent one is mt#3975's scope, not this
 *   module's — do not change it here.
 * - Consecutive assistant lines accumulate into a single assistant message ONLY
 *   while they share a `message.id` (one model turn split across JSONL records).
 *   A DIFFERING id closes the pending turn and opens a new one: without that
 *   check, two model turns with no intervening `user` line fuse into a single
 *   row, so one emitted turn no longer corresponds to one model turn (mt#3883 —
 *   measured at 46 events across 120 transcripts, touching 23.3% of them).
 * - Turns flush at the NEXT boundary rather than eagerly. Before mt#3883 an
 *   assistant line with no pending user flushed immediately, which split a
 *   same-id continuation following it into separate turns — the same defect in
 *   the other direction.
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
  /** `message.id` of the model turn currently accumulating (mt#3883). */
  let pendingAssistantMessageId: string | null = null;
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
    pendingAssistantMessageId = null;
    hasPendingUser = false;
    hasPendingAssistant = false;
  }

  for (const line of transcript) {
    if (line.type === "user") {
      const msg = line.message as Record<string, unknown> | undefined;
      const content = msg?.["content"];
      const blocks = normalizeContent(content);

      // mt#3131 (D6): a synthetic interrupt marker is harness plumbing, not a
      // real user prompt or a real turn boundary — skip it entirely (don't
      // flush, don't overwrite pending state, don't count it). Left
      // unexcluded, it can pair with a following assistant line and inflate
      // turnCount with a synthetic non-turn.
      if (isSyntheticInterruptLine(blocks)) continue;

      if (hasPendingAssistant) {
        // A pending turn ends here — either a complete (user, assistant) pair, or
        // an assistant-only run that mt#3883 stopped flushing eagerly. Both close
        // before this user line opens the next turn.
        flushTurn();
      }
      // A pending user with NO assistant is overwritten by this user line
      // (back-to-back user lines; the last one wins) — the supersession behavior
      // noted in the pairing algorithm above, owned by mt#3975.

      const text = extractUserText(blocks);

      pendingUserText = text;
      pendingUserStartedAt = parseTimestamp(line.timestamp);
      hasPendingUser = true;
    } else if (line.type === "assistant") {
      const msg = line.message as Record<string, unknown> | undefined;
      const content = msg?.["content"];
      const blocks = normalizeContent(content);
      const messageId = extractMessageId(line);

      // mt#3883: a DIFFERENT `message.id` means this line opens a NEW model turn,
      // so the pending one closes here. Accumulating across that boundary is the
      // fusion defect — two model turns land in one row and every later turn
      // index shifts by one.
      if (hasPendingAssistant && !continuesPendingModelTurn(pendingAssistantMessageId, messageId)) {
        flushTurn();
      }

      pendingAssistantBlocks.push(...blocks);
      // Keep the FIRST id seen for this turn: a continuation line that omits its
      // id must not erase the id the boundary check above reads.
      pendingAssistantMessageId ??= messageId;
      pendingAssistantEndedAt = parseTimestamp(line.timestamp);
      hasPendingAssistant = true;
    }
  }

  // Flush any trailing turn (e.g., a user message with no following assistant).
  if (hasPendingUser || hasPendingAssistant) {
    flushTurn();
  }

  return turns;
}
