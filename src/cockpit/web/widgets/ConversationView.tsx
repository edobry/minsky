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
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../lib/utils";
import {
  snapshotBlocksToConversation,
  type ConversationElement,
  type ConversationTurn,
} from "@minsky/domain/transcripts/conversation-elements";
import type { SessionContextSnapshot } from "@minsky/domain/context/types";

// ── Props ─────────────────────────────────────────────────────────────────────

type ConversationViewProps =
  | { sessionId: string; snapshot?: undefined; className?: string }
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

async function fetchSnapshot(sessionId: string): Promise<SessionContextSnapshot> {
  const res = await fetch(
    `/api/cockpit/context-inspector/snapshot?sessionId=${encodeURIComponent(sessionId)}`
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snapshot fetch failed (${res.status}): ${text}`);
  }
  const json: unknown = await res.json();
  if (!isSnapshot(json)) {
    throw new Error("Snapshot response did not match the expected shape");
  }
  return json;
}

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
  return (
    <details className="group rounded border border-border/60 bg-muted/20">
      <summary className="cursor-pointer select-none px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <span className="italic">thinking</span>
        <span className="ml-1 text-muted-foreground/60 group-open:hidden">
          ({thinking.length} chars — click to expand)
        </span>
      </summary>
      <pre className="whitespace-pre-wrap break-words px-2 pb-2 pt-1 text-xs text-muted-foreground">
        {thinking}
      </pre>
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
}: {
  element: ConversationElement;
  callNameByToolUseId: Map<string, string>;
}) {
  switch (element.kind) {
    case "text":
      return element.text.trim().length > 0 ? (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{element.text}</p>
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
}: {
  turn: ConversationTurn;
  callNameByToolUseId: Map<string, string>;
}) {
  const roleStyle = ROLE_STYLES[turn.role];
  const rendered = turn.elements
    .map((element, i) => {
      const node = (
        <ElementView key={i} element={element} callNameByToolUseId={callNameByToolUseId} />
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

function ConversationThread({
  snapshot,
  className,
}: {
  snapshot: SessionContextSnapshot;
  className?: string;
}) {
  const turns = useMemo(() => snapshotBlocksToConversation(snapshot.blocks), [snapshot.blocks]);

  // Map every tool_use id → tool name so a tool-result can name the call it answers.
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

  if (visibleTurns.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        This session has no conversational turns to display.
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {visibleTurns.map((turn) => (
        <TurnView key={turn.blockId} turn={turn} callNameByToolUseId={callNameByToolUseId} />
      ))}
    </div>
  );
}

// ── Self-fetching wrapper ───────────────────────────────────────────────────────

function ConversationFetcher({ sessionId, className }: { sessionId: string; className?: string }) {
  const query = useQuery<SessionContextSnapshot, Error>({
    queryKey: ["conversation", "snapshot", sessionId],
    queryFn: () => fetchSnapshot(sessionId),
    staleTime: 30_000,
  });

  if (query.isError) {
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
