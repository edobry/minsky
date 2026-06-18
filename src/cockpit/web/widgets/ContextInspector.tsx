/**
 * ContextInspector widget (mt#2023)
 *
 * The "Context" tab — a session picker, a scrollable categorized block list,
 * a content viewer side-panel, and filter chips. Composes two backend
 * surfaces:
 *
 *   1. `/api/widget/context-inspector/data` (widget framework) — returns
 *      the sessions-picker source (top-50 known agent sessions).
 *   2. `/api/cockpit/context-inspector/snapshot?sessionId=...` (custom
 *      endpoint) — returns the full SessionContextSnapshot for the selected
 *      session. The widget framework's single-payload shape doesn't fit the
 *      interactive picker → detail pattern, so the snapshot lives as a
 *      sibling endpoint.
 *
 * Self-fetching via TanStack Query for both surfaces. Frontend stays
 * self-contained (no imports of server code); mirror types defined inline
 * and kept in sync with the backend.
 *
 * @see mt#2023 — this widget
 * @see mt#2022 — substrate that the snapshot endpoint reads from
 * @see mt#2033 — canonical SessionContextSnapshot shape
 */
import { useMemo, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { isSessionsPayload } from "../lib/sessions-source";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

// ── Frontend mirror types — keep in sync with backend ─────────────────────────

/** Inline mirror of SessionContextSnapshotBlock from src/domain/context/types.ts. */
interface SnapshotBlock {
  id: string;
  type: string; // ContextElement["type"] — unified taxonomy from mt#2033
  source: "observed";
  content: unknown;
  parentUuid?: string;
  timestamp: string;
  turnIndex?: number;
  rawJsonlType: string;
}

/** Inline mirror of SessionContextSnapshot. */
interface Snapshot {
  agentSessionId: string;
  harness: string;
  blocks: SnapshotBlock[];
  assembledAt: string;
}

// ── Type guards ──────────────────────────────────────────────────────────────

function isSnapshot(value: unknown): value is Snapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentSessionId?: unknown }).agentSessionId === "string" &&
    Array.isArray((value as { blocks?: unknown }).blocks)
  );
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchSessions(): Promise<WidgetData> {
  return fetchWidgetData("context-inspector");
}

async function fetchSnapshot(sessionId: string): Promise<Snapshot> {
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

// ── Content-preview helpers ──────────────────────────────────────────────────

const PREVIEW_LEN = 80;

function stringifyContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function blockPreview(block: SnapshotBlock): string {
  const raw = stringifyContent(block.content);
  if (raw.length <= PREVIEW_LEN) return raw;
  return `${raw.slice(0, PREVIEW_LEN)}…`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().slice(11, 19); // HH:MM:SS
  } catch {
    return iso;
  }
}

// ── Filter chip set ──────────────────────────────────────────────────────────

/**
 * Categories that the filter chip row exposes. Each chip's `key` MUST match a
 * `block.type` value that the mt#2022 mappers actually produce — otherwise the
 * chip is a no-op (PR #1230 R1 BLOCKING finding).
 *
 * Produced values per `mapTurnTypeToBlockType` + `mapAttachmentTypeToBlockType`
 * in `src/domain/transcripts/session-context-snapshot.ts`:
 *
 *   - turn lines: `user-prompt`, `assistant-text`, `assistant-thinking`, `other`
 *   - attachment lines:
 *       - `hook_additional_context` / `task_reminder` / `auto_mode` → `hook-injection`
 *       - `deferred_tools_delta` → `deferred-tool-catalog`
 *       - `mcp_instructions_delta` → `mcp-instructions`
 *       - `skill_listing` → `skill-body`
 *       - else → `other`
 *   - system lines → `metadata`
 *
 * Other `ContextElement.type` values (`tool-result`, `tool-schema`,
 * `system-prompt`, etc.) exist in the canonical enum but aren't produced by
 * the current pipeline — their chips would be no-ops, so they're omitted here.
 * When mt#2022's mappers expand to produce them (or a sibling source does),
 * add matching chip entries.
 */
const FILTER_CHIPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "user-prompt", label: "user" },
  { key: "assistant-text", label: "assistant" },
  { key: "assistant-thinking", label: "thinking" },
  { key: "hook-injection", label: "hooks" },
  { key: "skill-body", label: "skills" },
  { key: "deferred-tool-catalog", label: "deferred-tools" },
  { key: "mcp-instructions", label: "mcp" },
  { key: "metadata", label: "metadata" },
  { key: "other", label: "other" },
];

// ── Block row + content viewer ───────────────────────────────────────────────

function BlockRow({
  block,
  selected,
  onClick,
}: {
  block: SnapshotBlock;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left flex items-baseline gap-3 py-1.5 px-2 border-b border-border last:border-0 hover:bg-muted/50 ${
        selected ? "bg-muted" : ""
      }`}
    >
      <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0 w-20">
        {formatTimestamp(block.timestamp)}
      </span>
      <span className="text-xs font-medium text-muted-foreground flex-shrink-0 w-32 truncate">
        {block.type}
      </span>
      <span className="text-xs text-foreground/80 truncate flex-1 min-w-0">
        {blockPreview(block)}
      </span>
    </button>
  );
}

function ContentViewer({ block }: { block: SnapshotBlock }) {
  const fullContent = useMemo(() => {
    if (typeof block.content === "string") return block.content;
    try {
      return JSON.stringify(block.content, null, 2);
    } catch {
      return String(block.content);
    }
  }, [block.content]);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-muted-foreground space-y-0.5">
        <div>
          <span className="font-medium">id:</span> {block.id}
        </div>
        <div>
          <span className="font-medium">type:</span> {block.type}
        </div>
        <div>
          <span className="font-medium">rawJsonlType:</span> {block.rawJsonlType}
        </div>
        <div>
          <span className="font-medium">timestamp:</span> {block.timestamp}
        </div>
        {block.turnIndex !== undefined && (
          <div>
            <span className="font-medium">turnIndex:</span> {block.turnIndex}
          </div>
        )}
        {block.parentUuid && (
          <div>
            <span className="font-medium">parentUuid:</span> {block.parentUuid}
          </div>
        )}
      </div>
      <pre className="text-xs whitespace-pre-wrap break-all bg-muted/30 rounded p-2 max-h-96 overflow-auto">
        {fullContent}
      </pre>
    </div>
  );
}

// ── Chrome-agnostic body — no Card/CardHeader/CardTitle in any branch ─────────

interface ContextInspectorBodyProps {
  sessionsQuery: UseQueryResult<WidgetData, Error>;
}

function ContextInspectorBody({ sessionsQuery }: ContextInspectorBodyProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [disabledChips, setDisabledChips] = useState<Set<string>>(new Set());

  const snapshotQuery = useQuery<Snapshot, Error>({
    queryKey: ["context-inspector", "snapshot", selectedSessionId],
    queryFn: () => fetchSnapshot(selectedSessionId as string),
    enabled: selectedSessionId !== null,
    staleTime: 30_000,
  });

  if (sessionsQuery.isError) {
    return <p className="text-muted-foreground text-sm">Failed to load sessions: {sessionsQuery.error.message}</p>;
  }
  if (sessionsQuery.isLoading || !sessionsQuery.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (sessionsQuery.data.state === "degraded") {
    return <p className="text-muted-foreground text-sm">{sessionsQuery.data.reason}</p>;
  }
  if (!isSessionsPayload(sessionsQuery.data.payload)) {
    return <p className="text-muted-foreground text-sm">Unexpected payload shape</p>;
  }

  const sessions = sessionsQuery.data.payload.sessions;

  // Filter chip toggle
  function toggleChip(key: string) {
    setDisabledChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Blocks for the selected session, with chip filter applied
  const visibleBlocks: SnapshotBlock[] =
    snapshotQuery.data?.blocks.filter((b) => !disabledChips.has(b.type)) ?? [];

  const selectedBlock =
    selectedBlockId !== null
      ? (snapshotQuery.data?.blocks.find((b) => b.id === selectedBlockId) ?? null)
      : null;

  return (
    <>
      {/* Session picker */}
      <div className="mb-3">
        <label className="text-xs font-medium text-muted-foreground block mb-1">Session</label>
        <select
          className="w-full text-sm bg-background border border-input rounded px-2 py-1"
          value={selectedSessionId ?? ""}
          onChange={(e) => {
            setSelectedSessionId(e.target.value || null);
            setSelectedBlockId(null);
          }}
        >
          <option value="">— select —</option>
          {sessions.map((s) => (
            <option key={s.agentSessionId} value={s.agentSessionId}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Filter chips */}
      <div className="mb-3 flex flex-wrap gap-1">
        {FILTER_CHIPS.map((chip) => {
          const disabled = disabledChips.has(chip.key);
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => toggleChip(chip.key)}
              className={`text-xs px-2 py-0.5 rounded border ${
                disabled
                  ? "bg-muted text-muted-foreground border-border line-through"
                  : "bg-background text-foreground border-input hover:bg-muted/50"
              }`}
              aria-pressed={!disabled}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Snapshot state */}
      {selectedSessionId === null ? (
        <p className="text-sm text-muted-foreground">Select a session to view its context.</p>
      ) : snapshotQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          Failed to load snapshot: {snapshotQuery.error?.message ?? "unknown error"}
        </p>
      ) : snapshotQuery.isLoading || !snapshotQuery.data ? (
        <p className="text-sm text-muted-foreground">Loading snapshot…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Block list */}
          <div className="border border-border rounded max-h-96 overflow-auto">
            {visibleBlocks.length === 0 ? (
              <p className="text-sm text-muted-foreground p-2">
                No blocks match the active filter set.
              </p>
            ) : (
              visibleBlocks.map((block) => (
                <BlockRow
                  key={block.id}
                  block={block}
                  selected={selectedBlockId === block.id}
                  onClick={() => setSelectedBlockId(block.id)}
                />
              ))
            )}
          </div>

          {/* Content viewer side-panel */}
          <div className="border border-border rounded p-2">
            {selectedBlock ? (
              <ContentViewer block={selectedBlock} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Click a block to view its full content.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── Main widget export (mt#2373) ─────────────────────────────────────────────

interface Props {
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

export function ContextInspector({ variant = "card", title = "Context" }: Props) {
  const sessionsQuery = useQuery<WidgetData, Error>({
    queryKey: ["context-inspector", "sessions"],
    queryFn: fetchSessions,
    staleTime: 30_000,
    refetchInterval: 15_000,
  });

  return (
    <WidgetShell variant={variant} title={title}>
      <ContextInspectorBody sessionsQuery={sessionsQuery} />
    </WidgetShell>
  );
}
