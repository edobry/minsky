/**
 * ToolPayload — content-type dispatcher for tool-call inputs and tool-result
 * content in the conversation view (mt#2552).
 *
 * Deterministic 2-way dispatch (see mt#2552 Implementation decisions):
 *   - JSON (structured value, or a string/text-block that JSON.parses to
 *     object/array) → a per-tool typed renderer if one is registered (Tier 3),
 *     else the generic `<JsonView>` (Tier 1 + Tier 2).
 *   - everything else → `<pre>` (unchanged raw text; no fuzzy prose detection).
 *
 * @see ../lib/tool-payload.ts — classifyToolPayload (the pure classifier)
 * @see ./JsonView.tsx — the generic tree + entity-enriched leaves
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { JsonView } from "./JsonView";
import { classifyToolPayload } from "../lib/tool-payload";
import { entityToPath } from "../lib/entity-codec";
import { parseToolName } from "../lib/tool-name";
import type { EntityIndex } from "../lib/entity-linkifier";

// ── Tier-3 registry — per-tool typed renderers ──────────────────────────────────
//
// Keyed by BARE tool name (`tasks_list`, not `mcp__minsky__tasks_list`) — the
// dispatcher normalizes raw transcript names via parseToolName before lookup
// (mt#2787). A renderer returns a ReactNode for a richer, domain rendering, or
// `null` to fall back to the generic JsonView (so a shape mismatch degrades
// gracefully). Per mt#2552 principal direction the registry ships with a SMALL
// seed set as proof-of-pattern; broader per-tool coverage is added reactively
// for high-traffic tools — do NOT pre-build it.

export type ToolResultRenderer = (data: unknown, entityIndex?: EntityIndex) => ReactNode | null;

/** Extract a task-like array from common list-result shapes; null if it doesn't fit. */
function asTaskArray(data: unknown): Array<Record<string, unknown>> | null {
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { tasks?: unknown }).tasks)
      ? (data as { tasks: unknown[] }).tasks
      : data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)
        ? (data as { results: unknown[] }).results
        : null;
  if (!arr || arr.length === 0) return null;
  const ok = arr.every(
    (t) => t !== null && typeof t === "object" && typeof (t as { id?: unknown }).id === "string"
  );
  return ok ? (arr as Array<Record<string, unknown>>) : null;
}

/** Seed renderer (proof-of-pattern): a compact, linked task list. */
function renderTasksList(data: unknown): ReactNode | null {
  const tasks = asTaskArray(data);
  if (!tasks) return null; // shape mismatch → generic tree
  return (
    <ul className="space-y-0.5 text-xs">
      {tasks.map((t, i) => {
        const id = String(t.id);
        const title = typeof t.title === "string" ? t.title : "";
        const status = typeof t.status === "string" ? t.status : "";
        return (
          <li key={i} className="flex items-baseline gap-2">
            <Link
              to={entityToPath("task", id)}
              className="font-mono text-primary underline-offset-2 hover:underline"
            >
              {id}
            </Link>
            {title && <span className="truncate text-foreground/80">{title}</span>}
            {status && <span className="ml-auto text-[10px] text-muted-foreground">{status}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export const TOOL_RESULT_RENDERERS: Record<string, ToolResultRenderer> = {
  tasks_list: renderTasksList,
};

// ── Dispatcher ──────────────────────────────────────────────────────────────────

export interface ToolPayloadProps {
  value: unknown;
  /** MCP tool name — selects a Tier-3 renderer when one is registered. */
  toolName?: string;
  entityIndex?: EntityIndex;
  /** Wrapper styling (border/tone) supplied by the host (ToolCall vs ToolResult). */
  className?: string;
}

/**
 * Render a tool payload. Returns null for empty payloads (the caller renders
 * nothing). JSON → Tier-3 renderer or JsonView; non-JSON → `<pre>`.
 */
export function ToolPayload({ value, toolName, entityIndex, className }: ToolPayloadProps) {
  const classified = classifyToolPayload(value);

  if (classified.kind === "text") {
    if (classified.text.length === 0) return null;
    return (
      <pre
        className={cn(
          "max-h-48 overflow-auto whitespace-pre-wrap break-words border-t px-2 py-1 text-xs",
          className
        )}
      >
        {classified.text}
      </pre>
    );
  }

  // Registry keys are BARE tool names; transcripts carry the harness-prefixed
  // form (`mcp__minsky__tasks_list`), so normalize before lookup (mt#2787).
  const custom = toolName ? TOOL_RESULT_RENDERERS[parseToolName(toolName).name] : undefined;
  const rendered = custom ? custom(classified.data, entityIndex) : null;
  return (
    <div className={cn("max-h-72 overflow-auto border-t px-2 py-1", className)}>
      {rendered ?? <JsonView data={classified.data} entityIndex={entityIndex} />}
    </div>
  );
}
