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
import { cn } from "../lib/utils";
import {
  snapshotBlocksToConversation,
  type ConversationElement,
  type ConversationTurn,
} from "@minsky/domain/transcripts/conversation-elements";
import type { SessionContextSnapshot } from "@minsky/domain/context/types";
import type { ConversationId } from "@minsky/domain/ids";
import type { EntityIndex } from "../lib/entity-linkifier";
import { useEntityIndex } from "../lib/use-entity-index";
import { Prose } from "../components/Prose";

// ── Props ─────────────────────────────────────────────────────────────────────

type ConversationViewProps =
  | { sessionId: ConversationId; snapshot?: undefined; className?: string }
  | { snapshot: SessionContextSnapshot; sessionId?: undefined; className?: string };

// ── Snapshot fetch (mirrors ContextInspector's endpoint usage) ─────────────────

function isSnapshot(value: unknown): value is SessionContextSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentSessionId?: unknown }).agentSessionId === "string" &&
    Array.isArray((value as { blocks?: unknown }).blocks)
  );
}

/**
 * Carries the HTTP status AND the structured error `code` so callers can
 * distinguish "no transcript" (404 / `session_not_found`) from a wrong-id-space
 * mistake (422 / `wrong_id_space`, mt#2525) and from real failures.
 */
class SnapshotError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

async function fetchSnapshot(sessionId: ConversationId): Promise<SessionContextSnapshot> {
  const res = await fetch(
    `/api/cockpit/context-inspector/snapshot?sessionId=${encodeURIComponent(sessionId)}`
  );
  if (!res.ok) {
    // The endpoint returns `{ error: { code, message } }`; fall back to the raw
    // body when it isn't that shape (e.g. a proxy/HTML error page).
    const raw = await res.text();
    let code: string | undefined;
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
      if (parsed.error && typeof parsed.error === "object") {
        if (typeof parsed.error.code === "string") code = parsed.error.code;
        if (typeof parsed.error.message === "string") detail = parsed.error.message;
      }
    } catch {
      // Non-JSON body — keep the raw text as the detail.
    }
    throw new SnapshotError(res.status, code, `Snapshot fetch failed (${res.status}): ${detail}`);
  }
  const json: unknown = await res.json();
  if (!isSnapshot(json)) {
    throw new Error("Snapshot response did not match the expected shape");
  }
  return json;
}

// ── Entity index for linkification ────────────────────────────────────────────
//
// The known-entity id-set used to linkify bare references (mt#NNNN, UUIDs) is
// now built by the shared `useEntityIndex` hook (../lib/use-entity-index.ts),
// extracted from this file in mt#2550 so every prose surface (`<Prose>`) shares
// one index. ConversationView consumes it via ConversationThread below.

// ── Content pretty-printing ────────────────────────────────────────────────────

/** Render an unknown tool input/result payload as readable text. */
function pretty(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  // tool_result content is often an array of { type: "text", text } blocks.
  if (Array.isArray(value)) {
    const texts = value
      .map((b) =>
        b !== null && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : null
      )
      .filter((t): t is string => t !== null);
    if (texts.length > 0) return texts.join("\n");
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

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

function ThinkingBlock({ thinking }: { thinking: string }) {
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
        <pre className="whitespace-pre-wrap break-words px-2 pb-2 pt-1 text-xs text-muted-foreground">
          {thinking}
        </pre>
      )}
    </details>
  );
}

function ToolCall({ element }: { element: Extract<ConversationElement, { kind: "tool-call" }> }) {
  const input = useMemo(() => pretty(element.input), [element.input]);
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
      {input.length > 0 && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-sky-500/20 px-2 py-1 text-xs text-foreground/80">
          {input}
        </pre>
      )}
    </div>
  );
}

function ToolResult({
  element,
  callName,
}: {
  element: Extract<ConversationElement, { kind: "tool-result" }>;
  callName: string | undefined;
}) {
  const body = useMemo(() => pretty(element.content), [element.content]);
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
      {/* Tool results are kept as preformatted text here. Rich rendering —
          JSON tree for JSON payloads, <Prose> for Markdown text — is owned by
          the content-type dispatcher in mt#2552 (depends on mt#2550's <Prose>);
          rendering JSON-shaped results as Markdown now would regress them. */}
      <pre
        className={cn(
          "max-h-48 overflow-auto whitespace-pre-wrap break-words border-t px-2 py-1 text-xs",
          element.isError
            ? "border-destructive/30 text-destructive"
            : "border-border/40 text-foreground/70"
        )}
      >
        {body}
      </pre>
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
        <ThinkingBlock thinking={element.thinking} />
      ) : null;
    case "tool-call":
      return <ToolCall element={element} />;
    case "tool-result":
      return (
        <ToolResult
          element={element}
          callName={element.toolUseId ? callNameByToolUseId.get(element.toolUseId) : undefined}
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
  className,
}: {
  snapshot: SessionContextSnapshot;
  className?: string;
}) {
  // Build the entity index for transcript linkification. Fetches the same
  // underlying data as CommandPalette via useEntityIndex (which uses distinct
  // query keys to avoid cache-shape collisions — see useEntityIndex for details).
  const entityIndex = useEntityIndex();

  const turns = useMemo(() => snapshotBlocksToConversation(snapshot.blocks), [snapshot.blocks]);

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
  className,
}: {
  sessionId: ConversationId;
  className?: string;
}) {
  const query = useQuery<SessionContextSnapshot, Error>({
    queryKey: ["conversation", "snapshot", sessionId],
    queryFn: () => fetchSnapshot(sessionId),
    staleTime: 30_000,
  });

  if (query.isError) {
    const snapErr = query.error instanceof SnapshotError ? query.error : null;
    // Fail LOUD on the wrong-id-space mistake (mt#2525 / mt#2420): a workspace
    // session id was passed where a harness conversation id is required. This
    // must NOT fall through to the "no transcript yet" empty state — that was
    // the original misleading surface. Also key off the 422 status so an
    // intermediary/proxy that drops the JSON body but preserves the status still
    // routes here (reviewer #1729 robustness suggestion).
    if (snapErr?.code === "wrong_id_space" || snapErr?.status === 422) {
      return (
        <div
          role="alert"
          className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}
        >
          <p className="text-sm font-medium text-destructive">
            Wrong id type for the conversation view.
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            This looks like a Minsky workspace session id, not a harness conversation id. Open the
            workspace&apos;s session detail page and use its &ldquo;View conversation&rdquo; link to
            reach the transcript.
          </p>
        </div>
      );
    }
    const notFound = snapErr?.status === 404;
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
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        Failed to load conversation: {query.error.message}
      </p>
    );
  }
  if (query.isLoading || !query.data) {
    return <p className={cn("text-sm text-muted-foreground", className)}>Loading conversation…</p>;
  }
  return <ConversationThread snapshot={query.data} className={className} />;
}

// ── Public component ────────────────────────────────────────────────────────────

/**
 * Renders a session's conversation as a chronological chat thread. Layout-agnostic:
 * the host supplies the chrome. Pass either `sessionId` (self-fetch) or `snapshot`
 * (pre-fetched).
 */
export function ConversationView(props: ConversationViewProps) {
  if (props.snapshot !== undefined) {
    return <ConversationThread snapshot={props.snapshot} className={props.className} />;
  }
  return <ConversationFetcher sessionId={props.sessionId} className={props.className} />;
}
