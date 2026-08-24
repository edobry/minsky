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
import { parseSessionWorkspacePath, toolInputPath } from "./session-path";

/** The subset of a tool-result element this registry needs. */
export interface ToolResultInfo {
  content: unknown;
  isError: boolean;
}

export type ToolSummaryFn = (input: unknown, result: ToolResultInfo | undefined) => string | null;

const MAX_DIGEST = 80;
const MAX_FRAGMENT = 48;
/** Divider between a digest's arg side and its outcome side. */
const SEPARATOR = " → ";

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
  return `${truncate(cmd, 60)}${SEPARATOR}${genericOutcomeDigest(result)}`;
}

/**
 * Truncate a path from the LEFT, keeping the tail. A path's filename is its
 * most informative segment, so eliding the head preserves what identifies the
 * file — the opposite of the generic first-N `truncate` used for prose.
 */
function truncatePath(path: string, max: number): string {
  const p = path.trim();
  return p.length <= max ? p : `…${p.slice(-(max - 1))}`;
}

/** Floor on the path budget, so a verbose outcome digest can't squeeze the path out. */
const MIN_PATH_BUDGET = 24;

/**
 * Path digest. A path under a session workspace shows only its
 * session-relative part: the `<state-dir>/sessions/<uuid>/` prefix is ~79
 * characters of identical-across-every-call boilerplate, which under a
 * first-N truncation consumed the whole line and left the filename invisible
 * (mt#3378). The session identity is not dropped — the summary line's tooltip
 * carries it, via `sessionFileTargetFor`.
 *
 * The path gets whatever `MAX_DIGEST` has left after the outcome digest and
 * the separator, rather than the fixed 60 this used to spend: `MAX_DIGEST` is
 * the real constraint on the line, and the outcome digest is short, so a fixed
 * sub-budget threw away room the line actually had.
 */
function pathSummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const path = toolInputPath(input);
  if (!path) return null;
  const target = parseSessionWorkspacePath(path);
  const outcome = genericOutcomeDigest(result);
  const budget = Math.max(MIN_PATH_BUDGET, MAX_DIGEST - outcome.length - SEPARATOR.length);
  return `${truncatePath(target?.relativePath ?? path, budget)}${SEPARATOR}${outcome}`;
}

function gitSummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const rec = record(input);
  const target = rec ? (str(rec.path) ?? str(rec.file) ?? str(rec.ref)) : undefined;
  const digest = genericOutcomeDigest(result);
  return target ? `${truncate(target, 40)}${SEPARATOR}${digest}` : `→ ${digest}`;
}

function querySummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const rec = record(input);
  const q = rec ? (str(rec.query) ?? str(rec.q) ?? str(rec.title) ?? str(rec.taskId)) : undefined;
  const digest = genericOutcomeDigest(result);
  return q ? `"${truncate(q, 40)}"${SEPARATOR}${digest}` : `→ ${digest}`;
}

// ── Consequence: what a call DID, not what its tool CAN do (mt#4437) ─────────

/**
 * Whether a call actually changed anything, read off its RESULT payload.
 *
 * `unknown` is the honest default and covers three distinct cases that must not
 * be collapsed into `unchanged`: no result is paired to the call yet (the
 * windowing case, mt#3481), the result is an error, or the tool's payload
 * simply carries no delta to read. Rendering any of those as "nothing changed"
 * would assert a fact the payload does not support — the inverse of the defect
 * this exists to fix.
 */
export type ToolConsequence = "changed" | "unchanged" | "unknown";

/** Parse a tool result whose content is a JSON object into that object. */
function resultJson(content: unknown): Record<string, unknown> | undefined {
  const direct = record(content);
  if (direct) return direct;
  const text = resultText(content);
  if (text === null) return undefined;
  const t = text.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return undefined;
  try {
    return record(JSON.parse(t));
  } catch {
    return undefined;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Read a call's consequence from its result payload.
 *
 * Deliberately keyed on the PAYLOAD's own fields rather than on the tool name:
 * the whole point is that a mutating name proves nothing about a given call.
 * A tool absent from this map is `unknown`, never `unchanged`.
 */
type ConsequenceFn = (result: ToolResultInfo) => ToolConsequence;

const CONSEQUENCE: Record<string, ConsequenceFn> = {
  tasks_status_set: (r) => {
    const j = resultJson(r.content);
    if (!j) return "unknown";
    if (typeof j.changed === "boolean") return j.changed ? "changed" : "unchanged";
    const prev = str(j.previousStatus);
    const next = str(j.newStatus);
    if (prev && next) return prev === next ? "unchanged" : "changed";
    return "unknown";
  },
  session_commit: (r) => {
    const j = resultJson(r.content);
    const files = j ? num(j.filesChanged) : undefined;
    if (files === undefined) return "unknown";
    return files > 0 ? "changed" : "unchanged";
  },
  memory_create: (r) => {
    const j = resultJson(r.content);
    if (!j) return "unknown";
    return str(j.shortId) || str(j.id) ? "changed" : "unknown";
  },
};

/**
 * What this call DID — `unknown` unless its result payload actually says.
 *
 * An errored call is `unknown` rather than `unchanged`: a failure can still
 * have mutated state before it failed, and the error is already rendered on its
 * own channel.
 */
export function toolConsequence(
  rawName: string,
  result: ToolResultInfo | undefined
): ToolConsequence {
  if (!result || result.isError) return "unknown";
  const { name } = parseToolName(rawName);
  return CONSEQUENCE[name]?.(result) ?? "unknown";
}

// ── Consequence digests: report the DELTA, not the target (mt#4437) ──────────

/** `mt#4437 · TODO → PLANNING`; a no-op shows the same value on both sides. */
function statusSetSummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const taskId = str(record(input)?.taskId);
  if (!result) return taskId ? `${taskId}${SEPARATOR}pending` : null;
  const j = resultJson(result.content);
  const prev = j ? str(j.previousStatus) : undefined;
  const next = j ? (str(j.newStatus) ?? str(record(j.result)?.status)) : undefined;
  const id = taskId ?? (j ? str(j.taskId) : undefined);
  if (!prev || !next) return null;
  return `${id ? `${id} · ` : ""}${prev} → ${next}`;
}

/**
 * `2 files +26/-2`; an empty commit reports `0 files` rather than a byte count.
 *
 * ASCII hyphen, not U+2212 MINUS SIGN (PR #3273 R1). This is diffstat notation,
 * which is ASCII everywhere it appears — and the digest is text a reader copies
 * into a search box or a commit message, where a lookalike glyph silently fails
 * to match.
 */
function commitSummary(_input: unknown, result: ToolResultInfo | undefined): string | null {
  if (!result) return null;
  const j = resultJson(result.content);
  const files = j ? num(j.filesChanged) : undefined;
  if (files === undefined) return null;
  const ins = j ? num(j.insertions) : undefined;
  const del = j ? num(j.deletions) : undefined;
  const delta = ins !== undefined && del !== undefined ? ` +${ins}/-${del}` : "";
  return `${files} file${files === 1 ? "" : "s"}${files > 0 ? delta : ""}`;
}

/** `→ mem#1188` — the minted id IS the consequence. */
function memoryCreateSummary(_input: unknown, result: ToolResultInfo | undefined): string | null {
  if (!result) return null;
  const j = resultJson(result.content);
  const id = j ? (str(j.shortId) ?? str(j.id)) : undefined;
  return id ? `${SEPARATOR.trim()} ${id}` : null;
}

/**
 * `tasks_spec_patch` reports no delta, so this reports the TARGET and makes no
 * consequence claim — the payload carries `success`/`taskId`/`message` and
 * nothing about whether the stored content actually changed. That gap is real
 * and is recorded rather than papered over (mt#4458 is the defect it enables;
 * mt#2583 owns surfacing richer tool-result columns). Listing it here keeps the
 * seed set honest instead of silently dropping the one member that cannot
 * answer the question.
 */
function specPatchSummary(input: unknown, result: ToolResultInfo | undefined): string | null {
  const taskId = str(record(input)?.taskId);
  if (!taskId) return null;
  return `${taskId}${SEPARATOR}${genericOutcomeDigest(result)}`;
}

// ── Seed registry (mt#2790 design direction: Bash/session_exec, Read/Edit/Write,
//    git_diff/git_log, tasks_search/tasks_list, memory_search) ─────────────────
const REGISTRY: Record<string, ToolSummaryFn> = {
  tasks_status_set: statusSetSummary,
  session_commit: commitSummary,
  memory_create: memoryCreateSummary,
  tasks_spec_patch: specPatchSummary,
  Bash: commandSummary,
  session_exec: commandSummary,
  Read: pathSummary,
  Write: pathSummary,
  Edit: pathSummary,
  NotebookEdit: pathSummary,
  session_read_file: pathSummary,
  session_write_file: pathSummary,
  session_edit_file: pathSummary,
  session_search_replace: pathSummary,
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
  const generic = arg ? `${arg}${SEPARATOR}${outcome}` : outcome;
  return truncate(generic, MAX_DIGEST);
}
