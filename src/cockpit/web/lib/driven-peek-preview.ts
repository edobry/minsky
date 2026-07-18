/**
 * driven-peek-preview.ts (mt#2912) — pure helper extracting a short,
 * human-readable preview of the most recent message in a driven session's
 * accumulated block stream, for the fleet-table peek composer.
 *
 * Deliberately minimal: unlike `packages/domain/src/transcripts/conversation-elements.ts`
 * (full conversation expansion consumed by `ConversationView`), the peek only
 * needs ONE line of context — "what did the session last say" — so this does
 * its own small extraction rather than pulling in the full turn-parsing
 * pipeline into a compact table-row panel.
 *
 * @see mt#2912 — this module
 * @see ../hooks/useDrivenSession.ts — supplies the `blocks` array this reads
 * @see ../widgets/AgentDrivenPeek.tsx — the sole consumer
 */
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { safeTruncate } from "@minsky/shared/safe-truncate";

const DEFAULT_MAX_LEN = 240;

interface AnthropicContentBlockLike {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
}

/**
 * Resolve the message-content array from a snapshot block's `content` field.
 * Mirrors `conversation-elements.ts`'s `resolveContentBlocks` at a smaller
 * scope (no tool-call/tool-result element typing — just enough to find
 * readable text).
 */
function contentBlocksOf(content: unknown): AnthropicContentBlockLike[] {
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const inner = (content as { content?: unknown }).content;
    if (typeof inner === "string") return [{ type: "text", text: inner }];
    if (Array.isArray(inner)) {
      return inner.filter(
        (b): b is AnthropicContentBlockLike => b !== null && typeof b === "object"
      );
    }
    return [];
  }
  if (Array.isArray(content)) {
    return content.filter(
      (b): b is AnthropicContentBlockLike => b !== null && typeof b === "object"
    );
  }
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return [];
}

function textFromBlocks(blocks: AnthropicContentBlockLike[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (typeof b.text === "string" && b.text.length > 0) {
      parts.push(b.text);
    } else if (typeof b.thinking === "string" && b.thinking.length > 0) {
      parts.push(b.thinking);
    } else if (b.type === "tool_use" && typeof b.name === "string" && b.name.length > 0) {
      parts.push(`[used tool: ${b.name}]`);
    }
  }
  return parts.join(" ").trim();
}

/**
 * The most recent block's readable text, truncated to `maxLen`. Returns
 * `null` when there are no blocks yet (session hasn't produced output) or the
 * last block has no extractable text (e.g. a bare tool-result block).
 */
export function lastMessagePreview(
  blocks: SessionContextSnapshotBlock[],
  maxLen: number = DEFAULT_MAX_LEN
): string | null {
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  const text = textFromBlocks(contentBlocksOf(last.content));
  if (text.length === 0) return null;
  return text.length > maxLen ? `${safeTruncate(text, maxLen, "head")}…` : text;
}
