/**
 * Conversation-element parser (mt#2374).
 *
 * Pure, dependency-free helper that expands a `SessionContextSnapshotBlock`
 * (one harness message line) into an ordered list of conversational
 * sub-elements — `text`, `thinking`, `tool-call`, `tool-result` — for the
 * cockpit conversation renderer (and, later, the context lens).
 *
 * ## Why this lives here (not in the renderer, not in the snapshot assembler)
 *
 * `assembleSessionContextSnapshot()` (mt#2022) preserves each turn's full
 * `message.content` verbatim in `block.content`, but types the block at the
 * line level (`assistant-text` / `assistant-thinking` / `user-prompt`) — the
 * `ContextElement` taxonomy has no per-sub-element granularity. The renderer
 * needs to render thinking, each tool call, and each tool result distinctly.
 *
 * Rather than (a) splitting the snapshot's per-line blocks (which would change
 * block ids/counts and regress the ContextInspector + snapshot tests + the
 * not-yet-built mt#2024/mt#2025 panes) or (b) side-reading
 * `agent_transcript_turns.tool_calls` (which has pre/post-mt#2381 encoding
 * drift and a per-paired-turn index that does not map to the per-line snapshot
 * stream), this helper parses the content the snapshot ALREADY carries. It is
 * pure (type-only imports), so it bundles into the browser and is unit-testable
 * in isolation, and it is shared so the context lens reuses the same expansion.
 *
 * Spawn-boundary detection reuses the canonical signal from `turn-extractor.ts`:
 * an assistant `tool_use` block with `name === "Agent"`.
 *
 * @see mt#2374 — this file (conversation renderer)
 * @see mt#2022 / mt#2033 — the SessionContextSnapshot shape this consumes
 * @see turn-extractor.ts — canonical capture-time spawn-boundary / tool-call signal
 */

import type { SessionContextSnapshotBlock } from "../context/types";

/** The Agent tool's name in the Claude Code harness (spawn-boundary signal). */
export const AGENT_TOOL_NAME = "Agent";

/** One conversational sub-element extracted from a turn's message content. */
export type ConversationElement =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | {
      kind: "tool-call";
      /** The harness tool_use id (used to associate a result with its call). */
      id?: string;
      /** Tool name, e.g. `mcp__minsky__tasks_get` or `Agent`. */
      name: string;
      /** Raw tool input payload (renderer pretty-prints). */
      input: unknown;
      /**
       * Present when this call is a subagent spawn (name === "Agent"). The
       * `agentKind` is the real subagent type when the harness recorded one,
       * else `undefined` (older Agent-tool shapes) — the renderer shows a bare
       * "→ subagent" label in that case rather than echoing a placeholder.
       */
      spawn?: { agentKind?: string };
    }
  | {
      kind: "tool-result";
      /** The tool_use id this result answers, if present. */
      toolUseId?: string;
      /** Raw result payload (string or block array; renderer pretty-prints). */
      content: unknown;
      isError: boolean;
    }
  | { kind: "unknown"; rawType: string; raw: unknown };

/** Conversational role of a turn. */
export type ConversationRole = "user" | "assistant" | "other";

/** One conversational turn — a single harness message line, expanded. */
export interface ConversationTurn {
  /** The snapshot block id this turn was derived from. */
  blockId: string;
  role: ConversationRole;
  /** ISO-8601 timestamp from the snapshot block. */
  timestamp: string;
  /** Transcript-array position, when the block carried one. */
  turnIndex?: number;
  /** Ordered sub-elements (text / thinking / tool-call / tool-result). */
  elements: ConversationElement[];
  /** True when this turn invoked a subagent via the Agent tool. */
  isSpawnBoundary: boolean;
  /** Agent kind for the spawn boundary (e.g. `Explore`, `general-purpose`). */
  spawnAgentKind?: string;
}

/** A loose view of an Anthropic-format content block. */
interface ContentBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Resolve the message-content array from a snapshot block's `content`.
 *
 * The assembler stores `block.content = line.message ?? line`. So `content` is
 * usually the harness `message` object (`{ role, content: <string | block[]> }`),
 * but defensively we also accept a bare array or a bare string.
 */
function resolveContentBlocks(content: unknown): ContentBlock[] {
  // message object → use its `.content`
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const inner = (content as { content?: unknown }).content;
    if (typeof inner === "string") return [{ type: "text", text: inner }];
    if (Array.isArray(inner)) {
      return inner.filter((b): b is ContentBlock => b !== null && typeof b === "object");
    }
    return [];
  }
  // bare array of blocks
  if (Array.isArray(content)) {
    return content.filter((b): b is ContentBlock => b !== null && typeof b === "object");
  }
  // bare string
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return [];
}

/**
 * Derive the subagent KIND from an Agent tool_use `input`. Claude Code carries
 * the agent type as `subagent_type` (e.g. `Explore`, `Plan`, `general-purpose`);
 * a `agentType` variant key is accepted as a fallback. Deliberately does NOT
 * fall back to `description` — that field is a free-text task summary (a full
 * sentence), not a kind, and using it would render a nonsense affordance like
 * "→ subagent (Review PR #371 …)". Returns `undefined` when no kind is present
 * (older Agent-tool shapes); callers render a generic "subagent" label then.
 */
export function spawnAgentKindFromInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const candidate = i["subagent_type"] ?? i["agentType"];
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return undefined;
}

function blockToElement(block: ContentBlock): ConversationElement {
  switch (block.type) {
    case "text":
      return { kind: "text", text: asString(block.text) };
    case "thinking":
    case "redacted_thinking":
      return { kind: "thinking", thinking: asString(block.thinking) };
    case "tool_use": {
      const name = asString(block.name);
      const el: ConversationElement = {
        kind: "tool-call",
        id: typeof block.id === "string" ? block.id : undefined,
        name,
        input: block.input,
      };
      if (name === AGENT_TOOL_NAME) {
        el.spawn = { agentKind: spawnAgentKindFromInput(block.input) };
      }
      return el;
    }
    case "tool_result":
      return {
        kind: "tool-result",
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        content: block.content,
        isError: block.is_error === true,
      };
    default:
      return { kind: "unknown", rawType: asString(block.type), raw: block };
  }
}

/**
 * Expand one snapshot block into a `ConversationTurn`. Returns `null` for
 * blocks that are not conversational turns (attachments, system/metadata
 * lines) — only `user` / `assistant` raw lines carry a conversation.
 */
export function snapshotBlockToConversationTurn(
  block: SessionContextSnapshotBlock
): ConversationTurn | null {
  const role: ConversationRole =
    block.rawJsonlType === "user"
      ? "user"
      : block.rawJsonlType === "assistant"
        ? "assistant"
        : "other";
  if (role === "other") return null;

  const elements = resolveContentBlocks(block.content).map(blockToElement);

  let isSpawnBoundary = false;
  let spawnAgentKind: string | undefined;
  for (const el of elements) {
    if (el.kind === "tool-call" && el.spawn) {
      isSpawnBoundary = true;
      spawnAgentKind = el.spawn.agentKind;
      break;
    }
  }

  return {
    blockId: block.id,
    role,
    timestamp: block.timestamp,
    turnIndex: block.turnIndex,
    elements,
    isSpawnBoundary,
    spawnAgentKind,
  };
}

/**
 * Expand a full snapshot's blocks into chronological conversation turns,
 * dropping non-conversational blocks. Input blocks are assumed already sorted
 * by timestamp (the assembler guarantees this).
 */
export function snapshotBlocksToConversation(
  blocks: SessionContextSnapshotBlock[]
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const block of blocks) {
    const turn = snapshotBlockToConversationTurn(block);
    if (turn !== null) turns.push(turn);
  }
  return turns;
}
