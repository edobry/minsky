/**
 * ConversationView (mt#2374) — readable chat-thread render of a session transcript.
 *
 * A LAYOUT-AGNOSTIC body component (per the mt#2373 widget contract): it takes
 * data + a render context and renders a chronological chat thread — it does NOT
 * assume it lives in a tab vs. a panel vs. a full page. The surrounding chrome
 * is supplied by the host (a WidgetShell variant, a page section, a tab body).
 *
 * Three ways to give it data (mt#2374 success criterion "given a session id or
 * a pre-fetched snapshot"; the third added by mt#2751):
 *   - `{ sessionId }`  — self-fetches the snapshot from the existing
 *                        `/api/cockpit/context-inspector/snapshot` endpoint
 *                        (mt#2023) via TanStack Query.
 *   - `{ snapshot }`   — renders a pre-fetched SessionContextSnapshot directly
 *                        (used by hosts that already hold the snapshot, and by
 *                        the layout-agnostic acceptance test).
 *   - `{ drivenSessionId, drivenBlocks }` — mt#2751 Rung 2B: renders a
 *                        driven-session's live blocks with NO DB snapshot at
 *                        all (a fresh spawn has no prior transcript). The
 *                        caller owns the single `useDrivenSession` WS
 *                        connection (so composer/status siblings can share
 *                        it) and passes its accumulated `blocks` straight
 *                        through — this variant just wraps them in an empty
 *                        base snapshot and feeds `ConversationThread`'s
 *                        EXISTING `extraBlocks` seam, so the two Rung-1 SSE
 *                        live-tail channels above and this driven WS channel
 *                        all share the identical rendering code path.
 *
 * Data comes from `assembleSessionContextSnapshot()` (mt#2022), which preserves
 * each turn's full `message.content` (thinking / tool_use / tool_result). The
 * per-line blocks are expanded into ordered conversational sub-elements by the
 * shared domain parser `snapshotBlocksToConversation` — NOT by a parallel
 * frontend copy, and NOT by reading the raw JSONL (the mt#2021 DB-only
 * invariant holds: the only substrate read is the snapshot endpoint).
 *
 * @see mt#2374 — this component
 * @see packages/domain/src/transcripts/conversation-elements.ts — the shared parser
 * @see mt#2370 — the session-tab frame this will eventually render into
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import {
  snapshotBlocksToConversation,
  type ConversationElement,
  type ConversationRole,
  type ConversationTurn,
} from "@minsky/domain/transcripts/conversation-elements";
import type { SessionContextSnapshot, SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import type { ConversationId, WorkspaceId } from "@minsky/domain/ids";
import type { EntityIndex } from "../lib/entity-linkifier";
import { useEntityIndex } from "../lib/use-entity-index";
import { Prose } from "../components/Prose";
import { ToolPayload } from "../components/ToolPayload";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { useLiveTail, useConversationLiveTail } from "../hooks/useLiveTail";
import { friendlyToolName, parseToolName } from "../lib/tool-name";
import { toolIconFor } from "../lib/tool-icon";
import { summarizeToolInvocation } from "../lib/tool-summary";
import {
  fetchSnapshot,
  snapshotQueryKey,
  snapshotRetry,
  SnapshotError,
} from "../lib/conversation-snapshot";

// ── Props ─────────────────────────────────────────────────────────────────────

type ConversationViewProps =
  | {
      sessionId: ConversationId;
      snapshot?: undefined;
      className?: string;
      /**
       * Minsky workspace sessionId (WorkspaceId). When provided, `ConversationFetcher`
       * opens the `GET /api/agents/:id/live-tail` SSE channel and appends new turns
       * in real time alongside the DB snapshot. The id-spaces are distinct — this must
       * NOT be the same string as `sessionId` (which is the harness agentSessionId).
       *
       * This is the pluggable live stream-source seam (mt#2232 Rung 1).
       * Mutually exclusive with `liveByConversationId` — when both are set,
       * this workspace-keyed channel takes precedence.
       */
      workspaceSessionId?: WorkspaceId;
      /**
       * Opt in to the conversation-keyed live-tail channel (mt#2749): when
       * `true` (and `workspaceSessionId` is NOT set), `ConversationFetcher`
       * opens `GET /api/conversation/:sessionId/live-tail` directly off
       * `sessionId` — no workspace/cwd bridge required. Used by the
       * conversation surface (`ConversationPage`, keyed by agentSessionId
       * alone) where no workspace context exists at all.
       */
      liveByConversationId?: boolean;
      drivenSessionId?: undefined;
      drivenBlocks?: undefined;
      /**
       * Called once when the snapshot fetch resolves to a genuine "no
       * transcript" 404 (mt#2769) — NOT for `wrong_id_space`, which has its
       * own inline fail-loud surface and is a routing mistake, not an
       * invalid entity. Lets a URL-routed host (e.g. `ConversationPage`)
       * prune its own tab-strip entry for an unresolvable id.
       */
      onNotFound?: () => void;
    }
  | {
      snapshot: SessionContextSnapshot;
      sessionId?: undefined;
      workspaceSessionId?: never;
      liveByConversationId?: never;
      onNotFound?: never;
      className?: string;
      drivenSessionId?: undefined;
      drivenBlocks?: undefined;
    }
  | {
      /**
       * Driven-session id (mt#2751 Rung 2B — the `DrivenSessionRecord.localId`
       * a `useDrivenSession` caller is connected to). Opt-in driven-source
       * variant mirroring `liveByConversationId`'s shape: pass a distinct id +
       * its accumulated blocks rather than a DB-fetched `sessionId`/`snapshot`.
       * Unlike the other two variants, ConversationView does NOT own the data
       * connection here — the caller's own `useDrivenSession(drivenSessionId)`
       * call is the single source of truth (so composer/status UI siblings
       * outside this component can share the same WebSocket), and its
       * `blocks` are passed straight through as `drivenBlocks`.
       */
      drivenSessionId: string;
      /** The `blocks` array from the caller's `useDrivenSession` hook. */
      drivenBlocks: SessionContextSnapshotBlock[];
      sessionId?: undefined;
      snapshot?: undefined;
      workspaceSessionId?: never;
      liveByConversationId?: never;
      className?: string;
    };

// ── Snapshot fetch — shared with ContextBlockView via lib/conversation-snapshot ──
// (mt#2768 "one snapshot query key" success criterion; see that module's docblock)

// ── Entity index for linkification ────────────────────────────────────────────
//
// The known-entity id-set used to linkify bare references (mt#NNNN, UUIDs) is
// now built by the shared `useEntityIndex` hook (../lib/use-entity-index.ts),
// extracted from this file in mt#2550 so every prose surface (`<Prose>`) shares
// one index. ConversationView consumes it via ConversationThread below.

// ── Time formatting ─────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().slice(11, 19); // HH:MM:SS
  } catch {
    return iso;
  }
}

// ── Element renderers ──────────────────────────────────────────────────────────

export function ThinkingBlock({
  thinking,
  entityIndex,
}: {
  thinking: string;
  entityIndex: EntityIndex;
}) {
  // Render the (potentially very large) body only while expanded — collapsed
  // thinking blocks otherwise pay full serialization/reconciliation cost for
  // text nobody is looking at (PR #1667 R1 non-blocking).
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group rounded border border-border/60 bg-muted/20"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <span className="italic">thinking</span>
        <span className="ml-1 text-muted-foreground/60 group-open:hidden">
          ({thinking.length} chars — click to expand)
        </span>
      </summary>
      {open && (
        // Thinking is agent reasoning prose — render as Markdown via the shared
        // <Prose> (same as assistant text), entity-aware. mt#2556 (mt#2550 follow-up).
        // Newline semantics intentionally match assistant text (Markdown soft
        // newlines): model reasoning is paragraph-structured. remark-breaks is NOT
        // enabled globally — it would regress spec/memory rendering on <Prose>'s
        // other callers (PR #1746 reviewer note).
        <Prose entityIndex={entityIndex} className="px-2 pb-2 pt-1 text-xs text-muted-foreground">
          {thinking}
        </Prose>
      )}
    </details>
  );
}

// ── Unified tool-invocation block (mt#2790) ─────────────────────────────────────
//
// A merged call+result block, collapsed by default to one summary line
// (icon + friendly name + arg/outcome digest), expandable to the full args +
// result payloads via the existing (unchanged) ToolPayload rendering. Errors
// default EXPANDED with destructive styling — a failure must never read as an
// ok-looking collapsed line.
//
// `expandSignal` is a view-level "expand all / collapse all" broadcast (see
// `ConversationThread`): each bump of `epoch` forces this block's local
// `open` state to `expandSignal.open`, while the per-block toggle button
// keeps working normally in between broadcasts.

type ExpandSignal = { epoch: number; open: boolean } | undefined;

function ToolInvocation({
  call,
  result,
  entityIndex,
  expandSignal,
}: {
  call: Extract<ConversationElement, { kind: "tool-call" }>;
  result?: Extract<ConversationElement, { kind: "tool-result" }>;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  const isError = result?.isError === true;
  // Errors default expanded; everything else collapsed (mt#2790 design direction).
  const [open, setOpen] = useState(isError);
  // Re-sync on a NEW broadcast only (epoch), not on every `expandSignal.open`
  // identity change — `expandSignal` is a fresh object per click by design.
  const expandEpoch = expandSignal?.epoch;
  useEffect(() => {
    if (expandSignal) setOpen(expandSignal.open);
  }, [expandEpoch]);

  const parsed = useMemo(() => parseToolName(call.name), [call.name]);
  const Icon = toolIconFor(parsed);
  const label = friendlyToolName(call.name);
  const digest = useMemo(
    () =>
      summarizeToolInvocation(
        call.name,
        call.input,
        result ? { content: result.content, isError: result.isError } : undefined
      ),
    [call.name, call.input, result]
  );

  return (
    <div
      className={cn(
        "rounded border",
        isError ? "border-destructive/50 bg-destructive/5" : "border-sky-500/30 bg-sky-500/5"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs"
      >
        <Icon
          aria-hidden
          className={cn("h-3.5 w-3.5 shrink-0", isError ? "text-destructive" : "text-sky-500/80")}
        />
        <span
          title={call.name}
          className={cn("shrink-0 font-mono font-medium", isError ? "text-destructive" : "text-sky-300")}
        >
          {label}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-muted-foreground",
            isError && "text-destructive/80"
          )}
        >
          {digest}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {call.spawn && (
            <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
              → subagent{call.spawn.agentKind ? ` (${call.spawn.agentKind})` : ""}
            </span>
          )}
          <span aria-hidden className="text-muted-foreground/60">
            {open ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t border-border/40">
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            args
          </div>
          {/* Full expanded body (mt#2552, unchanged): JSON → entity-aware JsonView, else <pre> */}
          <ToolPayload
            value={call.input}
            toolName={call.name}
            entityIndex={entityIndex}
            className="border-sky-500/20 text-foreground/80"
          />
          {result ? (
            <>
              <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                {result.isError ? "error" : "result"}
              </div>
              <ToolPayload
                value={result.content}
                toolName={call.name}
                entityIndex={entityIndex}
                className={cn(
                  result.isError
                    ? "border-destructive/30 text-destructive"
                    : "border-border/40 text-foreground/70"
                )}
              />
            </>
          ) : (
            <div className="px-2 py-1 text-xs text-muted-foreground/60">pending…</div>
          )}
        </div>
      )}
    </div>
  );
}

// Standalone fallback for a tool-result with no matching call in the rendered
// window (mt#2790) — keeps the pre-redesign treatment. Uncommon: happens when
// windowing/pagination cuts the call's turn out of view (or mt#2789's
// subagent-transcript duplication produces a result with no local call).
function ToolResult({
  element,
  callName,
  entityIndex,
}: {
  element: Extract<ConversationElement, { kind: "tool-result" }>;
  callName: string | undefined;
  entityIndex: EntityIndex;
}) {
  return (
    <div
      className={cn(
        "rounded border bg-muted/20",
        element.isError ? "border-destructive/40" : "border-border/60"
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span aria-hidden>{element.isError ? "⚠" : "↩"}</span>
        <span className="font-medium">{element.isError ? "tool error" : "tool result"}</span>
        {callName && <span className="font-mono text-muted-foreground/70">{callName}</span>}
      </div>
      {/* Content-type dispatch (mt#2552): JSON payloads → JsonView (a Tier-3
          per-tool renderer if registered, else the generic entity-aware tree);
          non-JSON content → <pre> (unchanged). */}
      <ToolPayload
        value={element.content}
        toolName={callName}
        entityIndex={entityIndex}
        className={cn(
          element.isError
            ? "border-destructive/30 text-destructive"
            : "border-border/40 text-foreground/70"
        )}
      />
    </div>
  );
}

// ── Tool-invocation pairing (mt#2790) ───────────────────────────────────────────
//
// A pre-render assembly pass that merges each tool-call with its matching
// tool-result (found via `toolUseId`), so the pair renders as ONE block
// instead of two turn-level blocks (a call under ASSISTANT, a result under
// USER). Pairing is scoped to the turns actually being rendered ("the
// rendered window") — a result whose call fell outside that set (windowing/
// pagination cut it, or mt#2789's subagent-transcript duplication) is an
// ORPHAN and keeps the pre-redesign standalone treatment; it is never
// silently dropped.

type ToolCallElement = Extract<ConversationElement, { kind: "tool-call" }>;
type ToolResultElement = Extract<ConversationElement, { kind: "tool-result" }>;

/** One conversational sub-element after tool-invocation pairing. */
type PreparedElement =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "tool-invocation"; call: ToolCallElement; result?: ToolResultElement }
  | { kind: "tool-result-orphan"; result: ToolResultElement; callName: string | undefined }
  | { kind: "unknown"; rawType: string; raw: unknown };

interface PreparedTurn {
  blockId: string;
  role: ConversationRole;
  timestamp: string;
  elements: PreparedElement[];
  isSpawnBoundary: boolean;
  spawnAgentKind?: string;
}

/**
 * Merge tool-calls with their matching tool-results across `turns` (the
 * turns actually being rendered — see module docblock). `callNameByToolUseId`
 * is built over the FULL, unwindowed transcript (unchanged pre-existing
 * behavior) so an orphan can still show which tool it answers even when that
 * tool's call turn isn't in the current set.
 */
function pairToolInvocations(
  turns: ConversationTurn[],
  callNameByToolUseId: Map<string, string>
): PreparedTurn[] {
  const callById = new Map<string, ToolCallElement>();
  const resultById = new Map<string, ToolResultElement>();
  for (const turn of turns) {
    for (const el of turn.elements) {
      if (el.kind === "tool-call" && el.id) callById.set(el.id, el);
      if (el.kind === "tool-result" && el.toolUseId) resultById.set(el.toolUseId, el);
    }
  }

  return turns.map((turn) => {
    const elements: PreparedElement[] = [];
    for (const el of turn.elements) {
      switch (el.kind) {
        case "tool-call": {
          const result = el.id ? resultById.get(el.id) : undefined;
          elements.push({ kind: "tool-invocation", call: el, result });
          break;
        }
        case "tool-result": {
          const pairedInWindow = el.toolUseId ? callById.has(el.toolUseId) : false;
          // Already rendered at the call's position above — don't duplicate,
          // and never under a USER-role label (mt#2790 success criterion).
          if (pairedInWindow) break;
          elements.push({
            kind: "tool-result-orphan",
            result: el,
            callName: el.toolUseId ? callNameByToolUseId.get(el.toolUseId) : undefined,
          });
          break;
        }
        default:
          elements.push(el);
      }
    }
    return {
      blockId: turn.blockId,
      role: turn.role,
      timestamp: turn.timestamp,
      elements,
      isSpawnBoundary: turn.isSpawnBoundary,
      spawnAgentKind: turn.spawnAgentKind,
    };
  });
}

function hasRenderablePreparedElement(el: PreparedElement): boolean {
  switch (el.kind) {
    case "text":
      return el.text.trim().length > 0;
    case "thinking":
      return el.thinking.trim().length > 0;
    default:
      return true;
  }
}

function ElementView({
  element,
  entityIndex,
  expandSignal,
}: {
  element: PreparedElement;
  /** Known-entity id-set for linkification of bare refs and minsky:// URIs. */
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  switch (element.kind) {
    case "text":
      // Assistant/user prose turns are Markdown — render via the shared <Prose>
      // (Markdown structure + entity-linkification). mt#2550.
      return element.text.trim().length > 0 ? (
        <Prose entityIndex={entityIndex}>{element.text}</Prose>
      ) : null;
    case "thinking":
      return element.thinking.trim().length > 0 ? (
        <ThinkingBlock thinking={element.thinking} entityIndex={entityIndex} />
      ) : null;
    case "tool-invocation":
      return (
        <ToolInvocation
          call={element.call}
          result={element.result}
          entityIndex={entityIndex}
          expandSignal={expandSignal}
        />
      );
    case "tool-result-orphan":
      return (
        <ToolResult element={element.result} callName={element.callName} entityIndex={entityIndex} />
      );
    case "unknown":
      return (
        <div className="rounded border border-border/40 bg-muted/10 px-2 py-1 text-xs text-muted-foreground">
          unsupported block{element.rawType ? `: ${element.rawType}` : ""}
        </div>
      );
  }
}

// Role → left accent + label styling for the thread.
const ROLE_STYLES: Record<ConversationTurn["role"], { accent: string; label: string }> = {
  user: { accent: "border-l-emerald-500/50", label: "user" },
  assistant: { accent: "border-l-sky-500/40", label: "assistant" },
  other: { accent: "border-l-border", label: "other" },
};

function TurnView({
  turn,
  entityIndex,
  expandSignal,
}: {
  turn: PreparedTurn;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  const roleStyle = ROLE_STYLES[turn.role];
  const rendered = turn.elements
    .map((element, i) => {
      const node = (
        <ElementView key={i} element={element} entityIndex={entityIndex} expandSignal={expandSignal} />
      );
      return node;
    })
    .filter(Boolean);

  // A turn with no renderable elements (e.g. an empty pairing) is skipped by the caller.
  return (
    <div className={cn("flex flex-col gap-2 border-l-2 pl-3", roleStyle.accent)}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="font-semibold">{roleStyle.label}</span>
        {turn.isSpawnBoundary && (
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium normal-case text-violet-300">
            → subagent{turn.spawnAgentKind ? ` (${turn.spawnAgentKind})` : ""}
          </span>
        )}
        <span className="ml-auto tabular-nums text-muted-foreground/60">
          {formatTime(turn.timestamp)}
        </span>
      </div>
      <div className="flex flex-col gap-2">{rendered}</div>
    </div>
  );
}

// ── Thread (pure, snapshot-in) ──────────────────────────────────────────────────

/**
 * Tail-first window (mt#2433): the measured cost on long sessions is the eager
 * MOUNT of every formatted block (265 blocks / ~1MB took >20s to first content;
 * the snapshot fetch itself is ~1s), so only the most recent INITIAL_TURNS
 * turns render on mount — the chat idiom: the operator cares about the newest
 * exchange. "Show older" reveals earlier turns in OLDER_CHUNK increments.
 */
const INITIAL_TURNS = 50;
const OLDER_CHUNK = 100;

function ConversationThread({
  snapshot,
  extraBlocks,
  className,
}: {
  snapshot: SessionContextSnapshot;
  /**
   * Live-tail blocks to append after the snapshot's historical blocks (mt#2232).
   * When non-empty, they are merged into the block list before turn conversion.
   * Block ids in `extraBlocks` must NOT collide with snapshot block ids — live
   * blocks use the `<agentSessionId>:live:<N>` scheme to guarantee this.
   */
  extraBlocks?: SessionContextSnapshotBlock[];
  className?: string;
}) {
  // Build the entity index for transcript linkification. Fetches the same
  // underlying data as CommandPalette via useEntityIndex (which uses distinct
  // query keys to avoid cache-shape collisions — see useEntityIndex for details).
  const entityIndex = useEntityIndex();

  // Merge snapshot blocks with any live-tail appends.
  const allBlocks = useMemo(
    () =>
      extraBlocks && extraBlocks.length > 0 ? [...snapshot.blocks, ...extraBlocks] : snapshot.blocks,
    [snapshot.blocks, extraBlocks]
  );

  const turns = useMemo(() => snapshotBlocksToConversation(allBlocks), [allBlocks]);

  // Map every tool_use id → tool name so a tool-result can name the call it answers.
  // Computed over ALL turns (not the window): a windowed tool-result may answer
  // a call that is currently outside the window.
  const callNameByToolUseId = useMemo(() => {
    const map = new Map<string, string>();
    for (const turn of turns) {
      for (const el of turn.elements) {
        if (el.kind === "tool-call" && el.id) map.set(el.id, el.name);
      }
    }
    return map;
  }, [turns]);

  // Drop turns with nothing renderable (e.g. empty user pairings).
  const visibleTurns = useMemo(
    () =>
      turns.filter((t) =>
        t.elements.some((e) =>
          e.kind === "text"
            ? e.text.trim().length > 0
            : e.kind === "thinking"
              ? e.thinking.trim().length > 0
              : true
        )
      ),
    [turns]
  );

  const [visibleCount, setVisibleCount] = useState(INITIAL_TURNS);
  // Persistent "Show all" mode: once chosen it tracks transcript GROWTH too —
  // a fixed count would silently re-clip the oldest turns (and resurface the
  // control) when a refetch adds turns to the same session (PR #1667 R1).
  const [showAll, setShowAll] = useState(false);

  // One-shot gate for the initial scroll-to-newest. Declared before the
  // session-change effect below, which re-arms it.
  const didInitialScrollRef = useRef(false);

  // New session in the same mounted component → window back to the tail.
  useEffect(() => {
    setVisibleCount(INITIAL_TURNS);
    setShowAll(false);
    // Each session load lands on the tail — including in-place session swaps
    // (same mounted component, new agentSessionId), so the one-shot scroll
    // gate re-arms here (PR #1667 R2 non-blocking).
    didInitialScrollRef.current = false;
  }, [snapshot.agentSessionId]);

  const effectiveCount = showAll ? visibleTurns.length : visibleCount;
  const windowedTurns = useMemo(
    () => visibleTurns.slice(Math.max(0, visibleTurns.length - effectiveCount)),
    [visibleTurns, effectiveCount]
  );
  const hiddenCount = visibleTurns.length - windowedTurns.length;

  // Merge call+result pairs within the rendered window (mt#2790), then drop
  // any turn that has nothing left to render (a pure-tool-result USER turn
  // whose result got merged into its call's block above).
  const preparedTurns = useMemo(
    () =>
      pairToolInvocations(windowedTurns, callNameByToolUseId).filter((t) =>
        t.elements.some(hasRenderablePreparedElement)
      ),
    [windowedTurns, callNameByToolUseId]
  );

  // View-level expand-all / collapse-all broadcast (mt#2790): each click bumps
  // `epoch` so every mounted ToolInvocation re-syncs its local `open` state.
  const [expandSignal, setExpandSignal] = useState<ExpandSignal>(undefined);

  // Land on the newest exchange once, after the windowed items are actually in
  // the DOM (layout effect keyed on the mounted count — an empty first commit
  // must not consume the one-shot; PR #1667 R1). Expanding "Show older" later
  // must not yank the scroll position, hence the one-shot flag.
  const endRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    if (preparedTurns.length === 0) return;
    didInitialScrollRef.current = true;
    if (hiddenCount > 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [preparedTurns.length, hiddenCount]);

  // Live-tail auto-scroll: when new turns arrive from the SSE stream (mt#2232),
  // scroll to the bottom so the operator sees them immediately. Only fires
  // when extraBlocks grows — not on the initial snapshot render (which has the
  // one-shot gate above). Keyed on extraBlocks.length so it fires once per new
  // live turn, not on every render.
  const extraBlocksLen = extraBlocks?.length ?? 0;
  useLayoutEffect(() => {
    if (extraBlocksLen === 0) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [extraBlocksLen]);

  if (visibleTurns.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        This session has no conversational turns to display.
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center justify-end gap-3 text-[11px] text-muted-foreground/70">
        <button
          type="button"
          onClick={() => setExpandSignal((s) => ({ epoch: (s?.epoch ?? 0) + 1, open: true }))}
          className="transition-colors hover:text-foreground hover:underline"
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={() => setExpandSignal((s) => ({ epoch: (s?.epoch ?? 0) + 1, open: false }))}
          className="transition-colors hover:text-foreground hover:underline"
        >
          Collapse all
        </button>
      </div>
      {hiddenCount > 0 && !showAll && (
        <div className="flex items-center justify-center gap-3 py-1">
          <button
            type="button"
            onClick={() => setVisibleCount((c) => c + OLDER_CHUNK)}
            className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            Show older ({hiddenCount} more)
          </button>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Show all
          </button>
        </div>
      )}
      {preparedTurns.map((turn) => (
        <TurnView key={turn.blockId} turn={turn} entityIndex={entityIndex} expandSignal={expandSignal} />
      ))}
      <div ref={endRef} aria-hidden />
    </div>
  );
}

// ── Driven-session wrapper (mt#2751 Rung 2B) ────────────────────────────────────

/** Stable empty-array reference — avoids recreating a fresh `[]` (and therefore
 * invalidating `ConversationThread`'s internal `useMemo`) on every render. */
const EMPTY_DRIVEN_BASE_BLOCKS: SessionContextSnapshotBlock[] = [];
/** Fixed placeholder — never read by any renderer; only present because
 * `SessionContextSnapshot.assembledAt` is required by the type. */
const DRIVEN_BASE_ASSEMBLED_AT = new Date(0).toISOString();

/**
 * Wraps a driven session's live-accumulated `drivenBlocks` in an empty base
 * snapshot and feeds them through `ConversationThread`'s `extraBlocks` seam —
 * the SAME renderer `ConversationFetcher` uses for the two SSE live-tail
 * channels above. Verifies mt#2751 success criterion 2 ("the display
 * component is shared with Rung 1... verified by shared code path").
 */
function DrivenSessionThread({
  drivenSessionId,
  drivenBlocks,
  className,
}: {
  drivenSessionId: string;
  drivenBlocks: SessionContextSnapshotBlock[];
  className?: string;
}) {
  const baseSnapshot = useMemo<SessionContextSnapshot>(
    () => ({
      agentSessionId: drivenSessionId,
      // `claude_code` is correct-by-construction here, not a placeholder: the
      // driven-session host (mt#2750) only ever spawns the genuine `claude`
      // binary, so a driven session IS a Claude Code harness session. If the
      // host ever drives a second harness, thread the harness through from the
      // driven-session record instead (mt#2751 R1 note).
      harness: "claude_code",
      blocks: EMPTY_DRIVEN_BASE_BLOCKS,
      assembledAt: DRIVEN_BASE_ASSEMBLED_AT,
    }),
    [drivenSessionId]
  );
  return (
    <ConversationThread
      snapshot={baseSnapshot}
      extraBlocks={drivenBlocks.length > 0 ? drivenBlocks : undefined}
      className={className}
    />
  );
}

// ── Self-fetching wrapper ───────────────────────────────────────────────────────

function ConversationFetcher({
  sessionId,
  workspaceSessionId,
  liveByConversationId,
  onNotFound,
  className,
}: {
  sessionId: ConversationId;
  /**
   * When provided, opens a live-tail SSE connection and appends new turns to
   * the static snapshot in real-time (mt#2232 Rung 1). Must be the Minsky
   * workspace sessionId (WorkspaceId) — NOT the same string as `sessionId`.
   */
  workspaceSessionId?: WorkspaceId;
  /**
   * When `true` (and `workspaceSessionId` is NOT set), opens the
   * conversation-keyed live-tail channel directly off `sessionId` (mt#2749).
   */
  liveByConversationId?: boolean;
  /** See `ConversationViewProps` — fires on a genuine 404, not on wrong_id_space. */
  onNotFound?: () => void;
  className?: string;
}) {
  const query = useQuery<SessionContextSnapshot, Error>({
    queryKey: snapshotQueryKey(sessionId),
    queryFn: () => fetchSnapshot(sessionId),
    staleTime: 30_000,
    retry: snapshotRetry,
  });

  // Live-tail seam: exactly one of the two channels is active per host —
  // workspaceSessionId (mt#2232, WorkspaceDetailPage) takes precedence when
  // both happen to be set; liveByConversationId (mt#2749, ConversationPage)
  // opens the conversation-keyed channel with no workspace bridge. Both hooks
  // are always called (rules-of-hooks) — each is a no-op when its id arg is
  // falsy, so only the selected channel actually connects.
  const workspaceLive = useLiveTail(workspaceSessionId);
  const conversationLive = useConversationLiveTail(
    liveByConversationId && !workspaceSessionId ? sessionId : undefined
  );
  const liveBlocks = workspaceSessionId ? workspaceLive.liveBlocks : conversationLive.liveBlocks;

  const snapErr = query.isError && query.error instanceof SnapshotError ? query.error : null;
  const wrongIdSpace = snapErr?.code === "wrong_id_space" || snapErr?.status === 422;
  const notFound = !wrongIdSpace && snapErr?.status === 404;

  // Report a genuine unresolvable id to the host (mt#2769) — e.g. so a
  // URL-routed page can prune its own tab-strip entry. NOT fired for
  // wrong_id_space: that's a routing mistake (a valid workspace id used on
  // the wrong route), not an invalid entity.
  useEffect(() => {
    if (notFound) onNotFound?.();
  }, [notFound, onNotFound]);

  if (query.isError) {
    // Fail LOUD on the wrong-id-space mistake (mt#2525 / mt#2420): a workspace
    // session id was passed where a harness conversation id is required. This
    // must NOT fall through to the "no transcript yet" empty state — that was
    // the original misleading surface. Also key off the 422 status so an
    // intermediary/proxy that drops the JSON body but preserves the status still
    // routes here (reviewer #1729 robustness suggestion).
    if (wrongIdSpace) {
      return (
        <div
          role="alert"
          className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}
        >
          <p className="text-sm font-medium text-destructive">
            Wrong id type for the conversation view.
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            This looks like a Minsky workspace session id, not a harness conversation id.{" "}
            <Link to={`/agents/${encodeURIComponent(sessionId)}`} className="underline">
              Open its workspace detail page
            </Link>{" "}
            and use its &ldquo;View conversation&rdquo; link to reach the transcript.
          </p>
        </div>
      );
    }
    if (notFound) {
      return (
        <div className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}>
          <p className="text-sm text-muted-foreground">
            No conversation transcript for this session yet.
          </p>
          <p className="max-w-md text-xs text-muted-foreground/70">
            Transcripts are ingested when a Claude Code session ends; this one may still be running,
            or its transcript was never ingested.
          </p>
        </div>
      );
    }
    return <ErrorState prefix="Failed to load conversation" error={query.error} className={className} />;
  }
  if (query.isLoading || !query.data) {
    return <LoadingState message="Loading conversation…" className={className} />;
  }
  return (
    <ConversationThread
      snapshot={query.data}
      extraBlocks={liveBlocks.length > 0 ? liveBlocks : undefined}
      className={className}
    />
  );
}

// ── Public component ────────────────────────────────────────────────────────────

/**
 * Renders a session's conversation as a chronological chat thread. Layout-agnostic:
 * the host supplies the chrome. Pass `sessionId` (self-fetch), `snapshot`
 * (pre-fetched), or `drivenSessionId`+`drivenBlocks` (mt#2751 live-only, no DB
 * snapshot).
 *
 * Two mutually-exclusive live-tail seams (both bridge a DB-fetched snapshot with
 * a live SSE append):
 *   - `workspaceSessionId` (mt#2232 Rung 1) — real-time appends bridged through
 *     a Minsky workspace. `sessionId` is the harness ConversationId;
 *     `workspaceSessionId` is the distinct Minsky workspace WorkspaceId.
 *   - `liveByConversationId` (mt#2749) — real-time appends opened directly off
 *     `sessionId` alone, no workspace bridge. Used on the conversation surface
 *     (`ConversationPage`), which has no workspace context at all.
 *
 * A third, fully-live seam needs no DB snapshot at all:
 *   - `drivenSessionId` + `drivenBlocks` (mt#2751 Rung 2B) — a driven session
 *     the caller is connected to via its own `useDrivenSession` hook; see
 *     `DrivenSessionThread` above.
 */
export function ConversationView(props: ConversationViewProps) {
  if (props.snapshot !== undefined) {
    return <ConversationThread snapshot={props.snapshot} className={props.className} />;
  }
  if (props.drivenSessionId !== undefined) {
    return (
      <DrivenSessionThread
        drivenSessionId={props.drivenSessionId}
        drivenBlocks={props.drivenBlocks}
        className={props.className}
      />
    );
  }
  return (
    <ConversationFetcher
      sessionId={props.sessionId}
      workspaceSessionId={props.workspaceSessionId}
      liveByConversationId={props.liveByConversationId}
      onNotFound={props.onNotFound}
      className={props.className}
    />
  );
}
