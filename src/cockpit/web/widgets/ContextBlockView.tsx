/**
 * ContextBlockView (mt#2768) — the Context tab body: a categorized block
 * list, filter chips, and a content viewer side-panel, keyed by a KNOWN
 * conversation id. No picker: the tab it lives on already selected the
 * conversation (via the run-detail Overview/Conversation tabs, or the
 * multi-conversation switcher) — re-picking here would duplicate that
 * selection UI (mt#2768 Behavior: "Context tab ... NO picker").
 *
 * Extracted from `ContextInspector.tsx`'s picker-based body (mt#2023). That
 * component's picker path is retired by this task; `ContextInspector.tsx`
 * itself is deleted (its only mount point, the standalone `/context` page,
 * is also retired) — this file is the surviving, reusable half.
 *
 * Shares its snapshot query key with `ConversationView` via
 * `lib/conversation-snapshot.ts` (mt#2768 "one snapshot query key" success
 * criterion) — viewing the Conversation tab and then the Context tab for the
 * same conversation performs ONE network fetch, not two.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSnapshot, snapshotQueryKey, snapshotRetry } from "../lib/conversation-snapshot";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import type { SessionContextSnapshot, SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import type { ConversationId } from "@minsky/domain/ids";

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

function blockPreview(block: SessionContextSnapshotBlock): string {
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
//
// See the mt#2023 docblock this was extracted from for the produced-value
// mapping this chip set's `key`s must match (`mapTurnTypeToBlockType` +
// `mapAttachmentTypeToBlockType` in session-context-snapshot.ts).
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
  block: SessionContextSnapshotBlock;
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

function ContentViewer({ block }: { block: SessionContextSnapshotBlock }) {
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

// ── Body (picker-less) ────────────────────────────────────────────────────────

function ContextBlockViewBody({ snapshot }: { snapshot: SessionContextSnapshot }) {
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [disabledChips, setDisabledChips] = useState<Set<string>>(new Set());

  function toggleChip(key: string) {
    setDisabledChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visibleBlocks = snapshot.blocks.filter((b) => !disabledChips.has(b.type));
  const selectedBlock =
    selectedBlockId !== null
      ? (snapshot.blocks.find((b) => b.id === selectedBlockId) ?? null)
      : null;

  return (
    <div className="flex flex-col gap-3">
      {/* Filter chips */}
      <div className="flex flex-wrap gap-1">
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
    </div>
  );
}

// ── Self-fetching wrapper ───────────────────────────────────────────────────

export interface ContextBlockViewProps {
  /** The conversation to show blocks for — no picker; the host already selected it. */
  agentSessionId: ConversationId;
  className?: string;
}

export function ContextBlockView({ agentSessionId }: ContextBlockViewProps) {
  const query = useQuery<SessionContextSnapshot, Error>({
    queryKey: snapshotQueryKey(agentSessionId),
    queryFn: () => fetchSnapshot(agentSessionId),
    staleTime: 30_000,
    retry: snapshotRetry,
  });

  if (query.isError) {
    return <ErrorState prefix="Failed to load snapshot" error={query.error} />;
  }
  if (query.isLoading || !query.data) {
    return <LoadingState message="Loading snapshot…" />;
  }
  return <ContextBlockViewBody snapshot={query.data} />;
}
