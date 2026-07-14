/**
 * Per-tool one-line summary registry for the conversation view's unified
 * tool-invocation block (mt#2790).
 *
 * Produces the collapsed digest — `"<arg digest> → <outcome digest>"` — shown
 * on the single summary line (icon + friendly name + this digest). Keyed by
 * BARE tool name (mt#2787's `parseToolName` normalizes the raw, possibly
 * `mcp__<server>__`-prefixed transcript name before lookup — same convention
 * as `ToolPayload`'s Tier-3 `TOOL_RESULT_RENDERERS`).
 *
 * A tool without a specific entry (or whose entry declines by returning
 * `null`, e.g. an unexpected input shape) falls back to a GENERIC digest:
 * the first scalar string field on the input, and a result line/byte/item
 * count on the outcome side. This is deliberately cheap and un-curated per
 * tool — see mt#2552's Tier-3 precedent ("ships with a SMALL seed set...
 * broader coverage is added reactively").
 */
import { parseToolName } from "./tool-name";

/** The subset of a tool-result element this registry needs. */
export interface ToolResultInfo {
  content: unknown;
  isError: boolean;
}

export type ToolSummaryFn = (input: unknown, result: ToolResultInfo | undefined) => string | null;

const MAX_DIGEST = 80;
const MAX_FRAGMENT = 48;

function truncate(text: string, max: number = MAX_FRAGMENT): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Flatten a tool-result content payload (string, or an Anthropic text-block array) to plain text. */
function resultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : ""
      )
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

/** Find a result-set length in a JSON result: a bare array, or a common wrapper key. */
function resultArrayLength(content: unknown): number | null {
  let data: unknown = content;
  if (!Array.isArray(data)) {
    const text = resultText(content);
    if (text === null) return null;
    const t = text.trim();
    const looksJson =
      (t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"));
    if (!looksJson) return null;
    try {
      data = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (Array.isArray(data)) return data.length;
  const rec = record(data);
  if (rec) {
    for (const key of ["results", "tasks", "items", "matches"]) {
      const val = rec[key];
      if (Array.isArray(val)) return val.length;
    }
  }
  return null;
}

/** Generic outcome digest: pending / error / result count / line-or-byte count / bare "ok". */
export function genericOutcomeDigest(result: ToolResultInfo | undefined): string {
  if (!result) return "pending";
  if (result.isError) return "error";
  const count = resultArrayLength(result.content);
  if (count !== null) return `${count} result${count === 1 ? "" : "s"}`;
  const text = resultText(result.content);
  if (text !== null && text.length > 0) {
    const lines = text.split("\n").length;
    return lines > 1 ? `ok · ${lines} lines` : `ok · ${text.length}b`;
  }
  return "ok";
}

/** Generic arg digest: the first non-empty string field on the input object. */
function genericArgDigest(input: unknown): string | undefined {
  const rec = record(input);
  if (!rec) return undefined;
  for (const value of Object.values(rec)) {
    const s = str(value);
    if (s) return truncate(s);
  }
  return undefined;
}

function commandSummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const rec = record(input);
  const cmd = rec ? (str(rec.command) ?? str(rec.script)) : undefined;
  if (!cmd) return null;
  return `${truncate(cmd, 60)} → ${genericOutcomeDigest(result)}`;
}

function pathSummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const rec = record(input);
  const path = rec ? (str(rec.file_path) ?? str(rec.path) ?? str(rec.filePath)) : undefined;
  if (!path) return null;
  return `${truncate(path, 60)} → ${genericOutcomeDigest(result)}`;
}

function gitSummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const rec = record(input);
  const target = rec ? (str(rec.path) ?? str(rec.file) ?? str(rec.ref)) : undefined;
  const digest = genericOutcomeDigest(result);
  return target ? `${truncate(target, 40)} → ${digest}` : `→ ${digest}`;
}

function querySummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const rec = record(input);
  const q = rec ? (str(rec.query) ?? str(rec.q) ?? str(rec.title) ?? str(rec.taskId)) : undefined;
  const digest = genericOutcomeDigest(result);
  return q ? `"${truncate(q, 40)}" → ${digest}` : `→ ${digest}`;
}

// ── Seed registry (mt#2790 design direction: Bash/session_exec, Read/Edit/Write,
//    git_diff/git_log, tasks_search/tasks_list, memory_search) ─────────────────
const REGISTRY: Record<string, ToolSummaryFn> = {
  Bash: commandSummary,
  session_exec: commandSummary,
  Read: pathSummary,
  Write: pathSummary,
  Edit: pathSummary,
  session_read_file: pathSummary,
  session_write_file: pathSummary,
  session_edit_file: pathSummary,
  git_diff: gitSummary,
  git_log: gitSummary,
  tasks_search: querySummary,
  tasks_list: querySummary,
  memory_search: querySummary,
};

/**
 * Produce the collapsed one-line digest for a tool invocation. `rawName` is
 * the transcript's raw (possibly `mcp__<server>__`-prefixed) name; looked up
 * via the mt#2787 bare-name normalizer. Falls back to the generic digest when
 * no entry matches, or the matched entry declines (returns `null`).
 */
export function summarizeToolInvocation(
  rawName: string,
  input: unknown,
  result: ToolResultInfo | undefined
): string {
  const { name } = parseToolName(rawName);
  const specific = REGISTRY[name]?.(input, result);
  if (specific !== null && specific !== undefined) return truncate(specific, MAX_DIGEST);
  const arg = genericArgDigest(input);
  const outcome = genericOutcomeDigest(result);
  const generic = arg ? `${arg} → ${outcome}` : outcome;
  return truncate(generic, MAX_DIGEST);
}
