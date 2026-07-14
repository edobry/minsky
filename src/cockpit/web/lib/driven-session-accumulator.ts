/**
 * Driven-session streaming-delta accumulation layer (mt#2751, Rung 2B).
 *
 * The genuinely-new work the RFC (`372937f0-3cb4-8142-b3e3-c7238d3b51ba`) calls
 * out for this rung: fold the raw stream-json event sequence the mt#2750 WS
 * channel forwards (`src/cockpit/driven-session-ws.ts` — `event.payload`
 * objects, replayed-then-live) into `SessionContextSnapshotBlock[]` so the
 * EXISTING `ConversationView` / `ConversationThread` renderer
 * (`../widgets/ConversationView.tsx`) can display them via its `extraBlocks`
 * seam — no second display component, no terminal emulator.
 *
 * Pure and dependency-free by design (mirrors
 * `packages/domain/src/transcripts/conversation-elements.ts`'s rationale) so
 * it bundles cleanly into the browser and is unit-testable in isolation. Does
 * NOT import `packages/domain/src/transcripts/session-context-snapshot.ts` —
 * that module pulls in drizzle/DB machinery that has no business in a
 * frontend bundle; the handful of lines this file needs from it
 * (`mapTurnTypeToBlockType`-equivalent, `assistantContentKind`-equivalent) are
 * reimplemented locally instead.
 *
 * ## Event shapes handled (per the mt#2751 spec's confirmed protocol)
 *
 * - `system` (subtype `init`) — records the harness session id.
 * - `stream_event` — token-level deltas. `event.type` is one of the Anthropic
 *   Messages-API streaming sub-events: `message_start`, `content_block_start`,
 *   `content_block_delta`, `content_block_stop`, `message_delta`,
 *   `message_stop`. THIS is the accumulation-layer input per the spec —
 *   folded into a single growing assistant turn block, one
 *   `SessionContextSnapshotBlock` per message_start..message_stop cycle, with
 *   one `ConversationElement` per content-block index (so interleaved text /
 *   thinking / tool_use blocks each render as their own element within the
 *   turn — see `conversation-elements.ts`).
 * - `assistant` — a COMPLETE assistant turn. Authoritative: replaces the
 *   in-progress streaming block for the same turn if one exists (same block
 *   id), or appends a fresh block directly when no `stream_event`s preceded it
 *   (e.g. a fixture/replay run without `--include-partial-messages`).
 * - `user` — a complete message (operator input echo, or a tool-result
 *   round-trip per mt#2750's "nested MCP tool-use" test). Always a fresh,
 *   already-complete top-level block — no accumulation needed.
 * - `result` — terminal per-turn summary (usage/cost/duration). NOT rendered
 *   as a conversation block (no `rawJsonlType` of `user`/`assistant`, so
 *   `snapshotBlockToConversationTurn` would drop it anyway) — surfaced
 *   separately via `resultSummary` for the status UI.
 * - `minsky_exit` / `minsky_error` — synthetic terminal frames from the host
 *   (see `driven-session-host.ts`'s `appendEvent` callers) — update
 *   `runStatus`/`errorMessage`, not rendered as blocks.
 * - Anything else — tolerated defensively (state passes through unchanged),
 *   mirroring the host's own "never throw on an unrecognized event" posture.
 *
 * @see mt#2751 — this module
 * @see mt#2750 — `src/cockpit/driven-session-ws.ts` / `driven-session-host.ts` (server side, wire protocol)
 * @see ../hooks/useDrivenSession.ts — the React hook that drives this reducer off a live WebSocket
 * @see ../widgets/ConversationView.tsx — the shared renderer this feeds
 * @see packages/domain/src/transcripts/conversation-elements.ts — the shared per-turn content-block parser
 */
import type { ContextElement, SessionContextSnapshotBlock } from "@minsky/domain/context/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Session-lifecycle status derived purely from the event stream (no WS-transport concerns — see useDrivenSession for the combined status). */
export type DrivenSessionRunStatus = "connecting" | "running" | "exited" | "crashed";

/**
 * Composer-facing interaction state (mt#2751 success criterion 3): distinct
 * from `runStatus` (process lifecycle) — this tracks whether the assistant is
 * mid-turn (composer disabled) or the channel is ready for the next operator
 * message.
 */
export type DrivenSessionInteractionState = "awaiting-input" | "streaming" | "exited";

/** Terminal per-turn summary from a `result` event — surfaced for the status UI, never rendered as a conversation block. */
export interface DrivenSessionResultSummary {
  subtype?: string;
  isError: boolean;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export interface DrivenAccumulatorState {
  /** Ordered, append-and-in-place-update block list — feed directly to `ConversationView`'s `extraBlocks`/`drivenBlocks` seam. */
  blocks: SessionContextSnapshotBlock[];
  harnessSessionId: string | null;
  runStatus: DrivenSessionRunStatus;
  interactionState: DrivenSessionInteractionState;
  resultSummary: DrivenSessionResultSummary | null;
  errorMessage: string | null;
  /** Internal — the in-flight assistant turn accumulator, or `null` when no `stream_event` turn is currently open. Not meant to be read by callers. */
  activeTurn: ActiveTurnAccumulator | null;
  /**
   * Internal — the block id of the most recently `message_stop`-completed
   * streamed turn that has NOT yet been superseded by its authoritative
   * `assistant` event. `message_stop` clears `activeTurn` (the raw streaming
   * lifecycle is done) but the turn's block id must survive until the
   * `assistant` event arrives so that event can replace-in-place rather than
   * append a duplicate block for the same turn. Cleared once consumed (by the
   * matching `assistant` event) or superseded (by the next `message_start`).
   */
  lastStreamedTurnId: string | null;
  /** Internal — monotonic counter for synthesizing stable, unique block ids. */
  turnSeq: number;
}

// ---------------------------------------------------------------------------
// Internal accumulation model
// ---------------------------------------------------------------------------

interface AccumulatingTextBlock {
  kind: "text";
  text: string;
}
interface AccumulatingThinkingBlock {
  kind: "thinking";
  thinking: string;
}
interface AccumulatingToolUseBlock {
  kind: "tool_use";
  id?: string;
  name: string;
  /** Raw concatenated `input_json_delta.partial_json` fragments — only valid JSON once the block is complete; parsed defensively on every render. */
  partialJson: string;
}
type AccumulatingContentBlock =
  | AccumulatingTextBlock
  | AccumulatingThinkingBlock
  | AccumulatingToolUseBlock;

interface ActiveTurnAccumulator {
  blockId: string;
  contentBlocks: Map<number, AccumulatingContentBlock>;
  /** Content-block indices in first-seen (== rendered) order. */
  order: number[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createInitialDrivenAccumulatorState(): DrivenAccumulatorState {
  return {
    blocks: [],
    harnessSessionId: null,
    runStatus: "connecting",
    interactionState: "awaiting-input",
    resultSummary: null,
    errorMessage: null,
    activeTurn: null,
    lastStreamedTurnId: null,
    turnSeq: 0,
  };
}

// ---------------------------------------------------------------------------
// Local mirrors of session-context-snapshot.ts's pure helpers (mt#2751 —
// deliberately NOT imported; that module pulls in drizzle/DB machinery that
// must not enter the frontend bundle. Kept in sync by hand; both are tiny and
// unlikely to drift.)
// ---------------------------------------------------------------------------

function assistantKindFromContent(content: unknown): ContextElement["type"] {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as Record<string, unknown>)["type"] === "thinking"
      ) {
        return "assistant-thinking";
      }
    }
  }
  return "assistant-text";
}

function assistantKindFromMessage(message: unknown): ContextElement["type"] {
  if (message !== null && typeof message === "object") {
    return assistantKindFromContent((message as Record<string, unknown>)["content"]);
  }
  return "assistant-text";
}

// ---------------------------------------------------------------------------
// Turn → SessionContextSnapshotBlock rendering
// ---------------------------------------------------------------------------

/** Render one accumulating content block to its Anthropic-shaped content-block object. */
function renderContentBlock(block: AccumulatingContentBlock): Record<string, unknown> {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking };
    case "tool_use": {
      let input: unknown = {};
      const trimmed = block.partialJson.trim();
      if (trimmed.length > 0) {
        try {
          input = JSON.parse(trimmed);
        } catch {
          // Still streaming — partial_json isn't valid JSON until the block
          // completes. Render an empty input rather than throwing; the
          // renderer shows this as a pending tool call until content_block_stop.
          input = {};
        }
      }
      return { type: "tool_use", id: block.id, name: block.name, input };
    }
  }
}

function renderTurnBlock(
  turn: ActiveTurnAccumulator,
  timestamp: string
): SessionContextSnapshotBlock {
  const content = turn.order.map((index) => {
    const b = turn.contentBlocks.get(index);
    return b ? renderContentBlock(b) : { type: "unknown" };
  });
  return {
    id: turn.blockId,
    type: assistantKindFromContent(content),
    source: "observed",
    content: { role: "assistant", content },
    timestamp,
    rawJsonlType: "assistant",
  };
}

/** Append-or-replace-in-place a block by id, preserving array position on replace (chronological order comes from first-insertion position). */
function upsertBlock(
  blocks: SessionContextSnapshotBlock[],
  block: SessionContextSnapshotBlock
): SessionContextSnapshotBlock[] {
  const idx = blocks.findIndex((b) => b.id === block.id);
  if (idx === -1) return [...blocks, block];
  return blocks.map((b, i) => (i === idx ? block : b));
}

// ---------------------------------------------------------------------------
// stream_event sub-event handling
// ---------------------------------------------------------------------------

function foldStreamEvent(
  state: DrivenAccumulatorState,
  evt: Record<string, unknown>
): DrivenAccumulatorState {
  const subtype = evt["type"];
  const now = new Date().toISOString();

  if (subtype === "message_start") {
    const turnSeq = state.turnSeq + 1;
    const activeTurn: ActiveTurnAccumulator = {
      blockId: `driven:turn:${turnSeq}`,
      contentBlocks: new Map(),
      order: [],
    };
    // A new streaming turn beginning supersedes any prior unconsumed
    // lastStreamedTurnId — that turn's authoritative `assistant` event (if it
    // was ever coming) should have arrived before the next message_start.
    return { ...state, activeTurn, lastStreamedTurnId: null, turnSeq, runStatus: "running" };
  }

  // Defensive: a content_block_* event with no preceding message_start
  // (shouldn't happen on the real wire, but the upstream schema is thin —
  // mirrors driven-session-host.ts's own defensive parsing posture).
  const turn: ActiveTurnAccumulator = state.activeTurn ?? {
    blockId: `driven:turn:${state.turnSeq + 1}`,
    contentBlocks: new Map(),
    order: [],
  };
  const turnSeqForSynthesized = state.activeTurn ? state.turnSeq : state.turnSeq + 1;

  if (subtype === "content_block_start") {
    const index = typeof evt["index"] === "number" ? evt["index"] : turn.order.length;
    const cb = (evt["content_block"] ?? {}) as Record<string, unknown>;
    const cbType = cb["type"];
    let block: AccumulatingContentBlock;
    if (cbType === "tool_use") {
      block = {
        kind: "tool_use",
        id: typeof cb["id"] === "string" ? cb["id"] : undefined,
        name: typeof cb["name"] === "string" ? cb["name"] : "",
        partialJson: "",
      };
    } else if (cbType === "thinking") {
      block = {
        kind: "thinking",
        thinking: typeof cb["thinking"] === "string" ? cb["thinking"] : "",
      };
    } else {
      block = { kind: "text", text: typeof cb["text"] === "string" ? cb["text"] : "" };
    }
    const contentBlocks = new Map(turn.contentBlocks);
    contentBlocks.set(index, block);
    const order = turn.order.includes(index) ? turn.order : [...turn.order, index];
    const newTurn: ActiveTurnAccumulator = { ...turn, contentBlocks, order };
    return {
      ...state,
      turnSeq: turnSeqForSynthesized,
      blocks: upsertBlock(state.blocks, renderTurnBlock(newTurn, now)),
      activeTurn: newTurn,
      runStatus: "running",
    };
  }

  if (subtype === "content_block_delta") {
    const index = typeof evt["index"] === "number" ? evt["index"] : 0;
    const delta = (evt["delta"] ?? {}) as Record<string, unknown>;
    const existing = turn.contentBlocks.get(index);
    if (!existing) return state; // delta with no matching start — nothing to append to, tolerate.

    let updated: AccumulatingContentBlock;
    if (existing.kind === "text" && typeof delta["text"] === "string") {
      updated = { ...existing, text: existing.text + delta["text"] };
    } else if (existing.kind === "thinking" && typeof delta["thinking"] === "string") {
      updated = { ...existing, thinking: existing.thinking + delta["thinking"] };
    } else if (existing.kind === "tool_use" && typeof delta["partial_json"] === "string") {
      updated = { ...existing, partialJson: existing.partialJson + delta["partial_json"] };
    } else {
      return state; // unrecognized delta shape for this block kind — tolerate, no-op.
    }

    const contentBlocks = new Map(turn.contentBlocks);
    contentBlocks.set(index, updated);
    const newTurn: ActiveTurnAccumulator = { ...turn, contentBlocks };
    return {
      ...state,
      turnSeq: turnSeqForSynthesized,
      blocks: upsertBlock(state.blocks, renderTurnBlock(newTurn, now)),
      activeTurn: newTurn,
    };
  }

  if (subtype === "content_block_stop") {
    // Already reflected incrementally by the deltas above — nothing further
    // to render. Keep the active turn open (message_stop closes it).
    return state;
  }

  if (subtype === "message_delta") {
    // NOT the terminator. Per the Anthropic Messages streaming protocol,
    // `message_delta` carries top-level message changes (final `stop_reason`,
    // cumulative `usage`) and arrives BEFORE `message_stop`, while the turn is
    // still open. Finalizing the turn here would clear `activeTurn` one event
    // early and fragment any content that streams between `message_delta` and
    // `message_stop` (mt#2751 R1). Leave the active turn open; `message_stop`
    // below is the sole terminator.
    return state;
  }

  if (subtype === "message_stop") {
    // The turn's raw model-streaming lifecycle is done — THIS is the terminator.
    // Leave the rendered block in place: a subsequent complete `assistant` event
    // (if any) replaces it authoritatively (via lastStreamedTurnId, since
    // activeTurn is cleared here); if none arrives, the streamed content IS the
    // final content.
    return {
      ...state,
      activeTurn: null,
      lastStreamedTurnId: state.activeTurn?.blockId ?? state.lastStreamedTurnId,
    };
  }

  // Unrecognized stream_event sub-type — tolerate defensively.
  return state;
}

// ---------------------------------------------------------------------------
// Top-level event folding
// ---------------------------------------------------------------------------

/**
 * Fold one raw stream-json `event.payload` object (as forwarded verbatim by
 * the mt#2750 WS channel) into the accumulator state. Pure — returns a new
 * state object; never mutates `state`.
 */
export function foldDrivenSessionEvent(
  state: DrivenAccumulatorState,
  payload: Record<string, unknown>
): DrivenAccumulatorState {
  const type = payload["type"];

  switch (type) {
    case "system": {
      if (payload["subtype"] !== "init") return state;
      const raw = payload["session_id"] ?? payload["sessionId"];
      return {
        ...state,
        harnessSessionId: typeof raw === "string" && raw.length > 0 ? raw : state.harnessSessionId,
        runStatus: state.runStatus === "connecting" ? "running" : state.runStatus,
      };
    }

    case "stream_event": {
      const evt = payload["event"];
      if (evt === null || typeof evt !== "object") return state;
      return {
        ...foldStreamEvent(state, evt as Record<string, unknown>),
        interactionState: "streaming",
      };
    }

    case "assistant": {
      // Prefer the just-finished streamed turn's id (message_stop already
      // fired, activeTurn cleared, lastStreamedTurnId records it) so this
      // replaces the streamed block in place; fall back to a still-open
      // activeTurn (assistant event arriving before message_stop, unusual but
      // defensive); else this is a fresh turn with no preceding stream_event
      // at all (fixture / non-partial-messages path).
      const reuseId = state.lastStreamedTurnId ?? state.activeTurn?.blockId;
      const turnSeq = reuseId ? state.turnSeq : state.turnSeq + 1;
      const blockId = reuseId ?? `driven:turn:${turnSeq}`;
      const block: SessionContextSnapshotBlock = {
        id: blockId,
        type: assistantKindFromMessage(payload["message"]),
        source: "observed",
        content: payload["message"] ?? payload,
        timestamp: new Date().toISOString(),
        rawJsonlType: "assistant",
      };
      return {
        ...state,
        blocks: upsertBlock(state.blocks, block),
        activeTurn: null,
        lastStreamedTurnId: null,
        turnSeq,
        runStatus: "running",
        interactionState: "streaming",
      };
    }

    case "user": {
      const turnSeq = state.turnSeq + 1;
      const block: SessionContextSnapshotBlock = {
        id: `driven:turn:${turnSeq}`,
        type: "user-prompt",
        source: "observed",
        content: payload["message"] ?? payload,
        timestamp: new Date().toISOString(),
        turnIndex: turnSeq,
        rawJsonlType: "user",
      };
      return {
        ...state,
        blocks: upsertBlock(state.blocks, block),
        turnSeq,
        interactionState: "streaming",
      };
    }

    case "result": {
      const summary: DrivenSessionResultSummary = {
        subtype: typeof payload["subtype"] === "string" ? payload["subtype"] : undefined,
        isError: payload["is_error"] === true || payload["subtype"] === "error",
        totalCostUsd:
          typeof payload["total_cost_usd"] === "number" ? payload["total_cost_usd"] : undefined,
        durationMs: typeof payload["duration_ms"] === "number" ? payload["duration_ms"] : undefined,
        numTurns: typeof payload["num_turns"] === "number" ? payload["num_turns"] : undefined,
      };
      return { ...state, resultSummary: summary, interactionState: "awaiting-input" };
    }

    case "minsky_exit": {
      const status = payload["status"];
      return {
        ...state,
        runStatus: status === "crashed" ? "crashed" : "exited",
        errorMessage: typeof payload["error"] === "string" ? payload["error"] : state.errorMessage,
        interactionState: "exited",
      };
    }

    case "minsky_error": {
      return {
        ...state,
        runStatus: "crashed",
        errorMessage:
          typeof payload["message"] === "string" ? payload["message"] : "Driven session error",
        interactionState: "exited",
      };
    }

    default:
      // Unrecognized/future event type — tolerate defensively, no state change.
      return state;
  }
}
