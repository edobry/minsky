/**
 * ConversationView (mt#2374) — readable chat-thread render of a session transcript.
 *
 * A LAYOUT-AGNOSTIC body component (per the mt#2373 widget contract): it takes
 * data + a render context and renders a chronological chat thread — it does NOT
 * assume it lives in a tab vs. a panel vs. a full page. The surrounding chrome
 * is supplied by the host (a WidgetShell variant, a page section, a tab body).
 *
 * Two ways to give it data (mt#2374 success criterion "given a session id or a
 * pre-fetched snapshot"):
 *   - `{ sessionId }`  — self-fetches the snapshot from the existing
 *                        `/api/cockpit/context-inspector/snapshot` endpoint
 *                        (mt#2023) via TanStack Query.
 *   - `{ snapshot }`   — renders a pre-fetched SessionContextSnapshot directly
 *                        (used by hosts that already hold the snapshot, and by
 *                        the layout-agnostic acceptance test).
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

function ToolCall({
  element,
  entityIndex,
}: {
  element: Extract<ConversationElement, { kind: "tool-call" }>;
  entityIndex: EntityIndex;
}) {
  return (
    <div className="rounded border border-sky-500/30 bg-sky-500/5">
      <div className="flex items-center gap-2 px-2 py-1 text-xs">
        <span aria-hidden className="text-sky-500/80">
          ⚙
        </span>
        <span className="font-mono font-medium text-sky-300">{element.name}</span>
        {element.spawn && (
          <span className="ml-auto rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
            → subagent{element.spawn.agentKind ? ` (${element.spawn.agentKind})` : ""}
          </span>
        )}
      </div>
      {/* tool-call args (mt#2552): JSON → entity-aware JsonView, else <pre> */}
      <ToolPayload
        value={element.input}
        toolName={element.name}
        entityIndex={entityIndex}
        className="border-sky-500/20 text-foreground/80"
      />
    </div>
  );
}

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

function ElementView({
  element,
  callNameByToolUseId,
  entityIndex,
}: {
  element: ConversationElement;
  callNameByToolUseId: Map<string, string>;
  /** Known-entity id-set for linkification of bare refs and minsky:// URIs. */
  entityIndex: EntityIndex;
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
    case "tool-call":
      return <ToolCall element={element} entityIndex={entityIndex} />;
    case "tool-result":
      return (
        <ToolResult
          element={element}
          callName={element.toolUseId ? callNameByToolUseId.get(element.toolUseId) : undefined}
          entityIndex={entityIndex}
        />
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
  callNameByToolUseId,
  entityIndex,
}: {
  turn: ConversationTurn;
  callNameByToolUseId: Map<string, string>;
  entityIndex: EntityIndex;
}) {
  const roleStyle = ROLE_STYLES[turn.role];
  const rendered = turn.elements
    .map((element, i) => {
      const node = (
        <ElementView
          key={i}
          element={element}
          callNameByToolUseId={callNameByToolUseId}
          entityIndex={entityIndex}
        />
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

  // Land on the newest exchange once, after the windowed items are actually in
  // the DOM (layout effect keyed on the mounted count — an empty first commit
  // must not consume the one-shot; PR #1667 R1). Expanding "Show older" later
  // must not yank the scroll position, hence the one-shot flag.
  const endRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    if (windowedTurns.length === 0) return;
    didInitialScrollRef.current = true;
    if (hiddenCount > 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [windowedTurns.length, hiddenCount]);

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
      {windowedTurns.map((turn) => (
        <TurnView
          key={turn.blockId}
          turn={turn}
          callNameByToolUseId={callNameByToolUseId}
          entityIndex={entityIndex}
        />
      ))}
      <div ref={endRef} aria-hidden />
    </div>
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
 * the host supplies the chrome. Pass either `sessionId` (self-fetch) or `snapshot`
 * (pre-fetched).
 *
 * Two mutually-exclusive live-tail seams:
 *   - `workspaceSessionId` (mt#2232 Rung 1) — real-time appends bridged through
 *     a Minsky workspace. `sessionId` is the harness ConversationId;
 *     `workspaceSessionId` is the distinct Minsky workspace WorkspaceId.
 *   - `liveByConversationId` (mt#2749) — real-time appends opened directly off
 *     `sessionId` alone, no workspace bridge. Used on the conversation surface
 *     (`ConversationPage`), which has no workspace context at all.
 */
export function ConversationView(props: ConversationViewProps) {
  if (props.snapshot !== undefined) {
    return <ConversationThread snapshot={props.snapshot} className={props.className} />;
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
