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

/**
 * Resolved child conversation ids, keyed by the spawning Agent call's harness
 * `tool_use` id (mt#3692).
 *
 * Assembled server-side from `agent_spawns` and carried on the snapshot, because
 * this module is deliberately pure (type-only imports) so it can bundle into the
 * browser. A missing entry means the spawn's child was never resolved — the
 * common case today, at roughly 30% resolved — and renders as a static badge.
 */
export type SpawnChildrenByToolUseId = Readonly<Record<string, string>>;

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
       *
       * `childAgentSessionId` is the conversation this call spawned, when it
       * resolved (mt#3692); `undefined` means unresolved, and the renderer keeps
       * the badge static rather than linking somewhere it cannot reach.
       */
      spawn?: { agentKind?: string; childAgentSessionId?: string };
    }
  | {
      kind: "tool-result";
      /** The tool_use id this result answers, if present. */
      toolUseId?: string;
      /** Raw result payload (string or block array; renderer pretty-prints). */
      content: unknown;
      isError: boolean;
      /**
       * True when `content` is the canonical Claude Code interruption-
       * rejection message ("The user doesn't want to proceed with this tool
       * use...") — the harness marks this `is_error: true` too, so a naive
       * error tally can't distinguish a genuine tool FAILURE from the user
       * cancelling a pending call (mt#3131 D6). `isError` above stays truthful
       * to the raw harness flag (still renders as an error bubble — the
       * amber "Interrupted" visual treatment is separate, out-of-scope
       * follow-up work); this flag is for AGGREGATE counting only, e.g.
       * `computeConversationStats`'s `toolErrorCount`.
       */
      isInterruptionRejection: boolean;
    }
  | {
      kind: "image";
      /**
       * The Anthropic content-block source discriminator — `base64`, `url`, or
       * `file` (docs.claude.com, Messages API image blocks). Kept as a plain
       * string rather than a union: this parses a THIRD-PARTY payload, and a
       * source type we don't know yet must degrade to the placeholder rather
       * than fail to parse.
       */
      sourceType: string;
      /** e.g. `image/png`. Present on `base64` sources; absent otherwise. */
      mediaType?: string;
      /** Base64 payload — present only when `sourceType === "base64"`. */
      data?: string;
      /** Remote URL — present only when `sourceType === "url"`. */
      url?: string;
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
  /**
   * Child conversation for the turn-level spawn badge (mt#3692) — the FIRST
   * spawn on the turn, matching how `spawnAgentKind` above is derived. Per-call
   * children live on each `tool-call` element's `spawn`, which is what a
   * multi-spawn turn needs.
   */
  spawnChildAgentSessionId?: string;
  /**
   * True when this turn IS Claude Code's context-compaction summary (mt#3260).
   * Renders as a labeled boundary rather than as an unmarked giant user turn.
   */
  isCompactSummary?: boolean;
  /**
   * True when the harness — not the operator — generated this turn (mt#3322).
   * Carried by the `<local-command-caveat>` line attached to a slash-command
   * invocation, whose body is addressed to the model rather than the reader.
   */
  isMeta?: boolean;
  /**
   * Who authored this `user` turn's text, from mt#4289's `classifyUserLineOrigin`
   * (mt#4354) — the same classifier that writes `agent_transcript_turns.user_origin`.
   *
   * `"human"` is that classifier's FAIL-OPEN default and carries no information;
   * only a NON-`"human"` value is a positive claim about authorship. Absent on
   * assistant turns and on user turns whose content is entirely `tool_result`.
   */
  userOrigin?: string;
  /**
   * The assistant message's model, when recorded. `"<synthetic>"` marks a
   * harness-generated retry turn rather than a real model response (mt#3260).
   */
  model?: string;
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
 * Prefix of the canonical Claude Code tool-result content emitted when a
 * pending tool call is rejected because the user interrupted it — recorded
 * with `is_error: true` alongside genuine tool failures, so an aggregate
 * error tally needs this to tell the two apart (mt#3131 D6). Verified
 * against a live corpus specimen (2026-07-13 transcript,
 * `a9c1a09b-d7c8-4d95-bc49-70cfa922f0d7`): the full observed string is "The
 * user doesn't want to proceed with this tool use. The tool use was
 * rejected (eg. if it was a file edit, the new_string was NOT written to the
 * file). STOP what you are doing and wait for the user to tell you how to
 * proceed." — matching on the stable opening sentence rather than the full
 * text so minor harness wording changes downstream don't silently break the
 * match.
 */
const INTERRUPTION_REJECTION_PREFIX = "The user doesn't want to proceed with this tool use.";

/** True iff a tool_result's raw `content` is the interruption-rejection message. */
function isInterruptionRejectionContent(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(INTERRUPTION_REJECTION_PREFIX);
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

/**
 * Expand an Anthropic `image` content block into an image element.
 *
 * Every field is read defensively and the block is NEVER rejected: this parses
 * a third-party payload whose shape we do not control, and a turn that carried
 * an image must not disappear from the transcript because its source shape was
 * unfamiliar. An unrecognized or malformed source yields an element with a
 * `sourceType` but no `data`/`url`, which the renderer draws as a labeled
 * placeholder rather than a broken image.
 */
function imageBlockToElement(block: ContentBlock): ConversationElement {
  const source = block.source;
  if (source === null || typeof source !== "object") {
    return { kind: "image", sourceType: "" };
  }
  const s = source as Record<string, unknown>;
  const sourceType = asString(s.type);
  const element: ConversationElement = { kind: "image", sourceType };

  if (sourceType === "base64") {
    const mediaType = asString(s.media_type);
    const data = asString(s.data);
    if (mediaType) element.mediaType = mediaType;
    // An empty `data` stays absent so the renderer's placeholder branch fires
    // rather than emitting a `data:` URI with nothing after the comma.
    if (data) element.data = data;
  } else if (sourceType === "url") {
    const url = asString(s.url);
    if (url) element.url = url;
  }

  return element;
}

function blockToElement(
  block: ContentBlock,
  spawnChildren?: SpawnChildrenByToolUseId
): ConversationElement {
  switch (block.type) {
    case "text":
      return { kind: "text", text: asString(block.text) };
    case "thinking":
    case "redacted_thinking":
      return { kind: "thinking", thinking: asString(block.thinking) };
    case "tool_use": {
      const name = asString(block.name);
      const id = typeof block.id === "string" ? block.id : undefined;
      const el: ConversationElement = {
        kind: "tool-call",
        id,
        name,
        input: block.input,
      };
      if (name === AGENT_TOOL_NAME) {
        // The tool_use id is what `agent_spawns` is keyed on (mt#3692), so the
        // child resolves per CALL — a turn dispatching several subagents links
        // each badge to its own child, and an unresolved sibling stays static.
        el.spawn = {
          agentKind: spawnAgentKindFromInput(block.input),
          childAgentSessionId: id ? spawnChildren?.[id] : undefined,
        };
      }
      return el;
    }
    case "tool_result":
      return {
        kind: "tool-result",
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        content: block.content,
        isError: block.is_error === true,
        isInterruptionRejection: isInterruptionRejectionContent(block.content),
      };
    case "image":
      return imageBlockToElement(block);
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
  block: SessionContextSnapshotBlock,
  spawnChildren?: SpawnChildrenByToolUseId
): ConversationTurn | null {
  const role: ConversationRole =
    block.rawJsonlType === "user"
      ? "user"
      : block.rawJsonlType === "assistant"
        ? "assistant"
        : "other";
  if (role === "other") return null;

  const elements = resolveContentBlocks(block.content).map((b) => blockToElement(b, spawnChildren));

  let isSpawnBoundary = false;
  let spawnAgentKind: string | undefined;
  let spawnChildAgentSessionId: string | undefined;
  for (const el of elements) {
    if (el.kind === "tool-call" && el.spawn) {
      isSpawnBoundary = true;
      spawnAgentKind = el.spawn.agentKind;
      spawnChildAgentSessionId = el.spawn.childAgentSessionId;
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
    spawnChildAgentSessionId,
    isCompactSummary: block.isCompactSummary,
    isMeta: block.isMeta,
    userOrigin: block.userOrigin,
    model: block.model,
  };
}

/**
 * Expand a full snapshot's blocks into chronological conversation turns,
 * dropping non-conversational blocks. Input blocks are assumed already sorted
 * by timestamp (the assembler guarantees this).
 */
export function snapshotBlocksToConversation(
  blocks: SessionContextSnapshotBlock[],
  spawnChildren?: SpawnChildrenByToolUseId
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const block of blocks) {
    const turn = snapshotBlockToConversationTurn(block, spawnChildren);
    if (turn !== null) turns.push(turn);
  }
  return turns;
}
