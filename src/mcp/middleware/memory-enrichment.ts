/**
 * Memory enrichment middleware (mt#1588 spike).
 *
 * Half-day spike that wires `memory_search` into the MCP server's
 * `CallToolRequestSchema` dispatch path. When an allowlisted tool returns,
 * the middleware searches the memory store for context relevant to the tool
 * call and appends the top-K results as an additional `{type:"text"}` content
 * block in the tool response.
 *
 * Per the planning escalation (recorded in mt#1588's spec), this prototype
 * uses **Option A — inline content block** as the delivery shape. Other shapes
 * (out-of-band notifications, MCP `prompts`/`resources` primitives) are
 * deferred to follow-on work if the spike report's iterate/abandon call
 * surfaces a need for them.
 *
 * Spike scope (do not extend beyond this without filing follow-on tasks):
 * - Single allowlist (`tasks.get`)
 * - Stringified `toolName + args` as query (no per-tool query shaping)
 * - K=3 results max, ~2000-char total budget
 * - Errors and `degraded: true` returns are silently dropped (no-op)
 * - **Opt-in env var**: `MINSKY_MCP_MEMORY_ENRICHMENT=1` (or `"true"`) enables the
 *   middleware. Default is disabled — spike wiring must NOT activate in
 *   production unless explicitly opted in (PR #974 R1 BLOCKING).
 * - Object/array argument values are redacted (key included, value dropped) to
 *   avoid embedding arbitrarily large payloads or sensitive data into the
 *   memory_search query (PR #974 R1 BLOCKING).
 * - Query is hard-capped at MAX_QUERY_LENGTH chars to bound embedding cost.
 *
 * @see mt#1588 — this spike
 * @see mt#1589 — the harness-specific hook this is the structural retirement target for
 * @see mt#762 — RFC framing the MCP-middleware pattern (for enforcement; this is enrichment)
 */

import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemorySearchResult } from "@minsky/domain/memory/types";
import { log } from "@minsky/shared/logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";

/**
 * Tools the spike enriches. Hardcoded for spike scope. Production graduation
 * (if this shape is chosen) introduces an opt-in registration mechanism.
 */
const ENRICHMENT_ALLOWLIST = new Set<string>(["tasks.get"]);

/** Top-K results returned by memory_search. */
const DEFAULT_K = 3;

/** Total character budget for the enrichment block (envelope + results). */
const DEFAULT_CHAR_BUDGET = 2000;

/** Max length per result snippet — embeddings get chatty without trimming. */
const PER_RESULT_CHAR_BUDGET = 500;

/**
 * Hard cap on the constructed search query in characters. Mirrors the
 * `MAX_QUERY_LENGTH = 500` constant used by mt#1589's UserPromptSubmit hook.
 * Embeddings get noisy past a few hundred chars and arbitrary tool args could
 * embed unbounded content (PR #974 R1 BLOCKING).
 */
const MAX_QUERY_LENGTH = 500;

/**
 * Conservative regex for sensitive-arg key names. When a string arg's KEY
 * matches this pattern, the VALUE is redacted in `buildQuery` (key included
 * as a hint that the arg was set, value dropped) — same shape as
 * object/array redaction. Bounds the spike's data-exposure surface for
 * future allowlist expansions where arbitrary string args might appear
 * (PR #974 R4 BLOCKING #3).
 *
 * Spike scope: a hardcoded conservative pattern is enough today since the
 * allowlist contains only `tasks.get` (no sensitive args possible). A
 * configurable per-tool key allowlist is mt#1631-class follow-on work.
 */
const SENSITIVE_KEY_PATTERN = /(token|secret|password|apikey|api_key|authorization|auth)/i;

/**
 * Default timeout (ms) for the memory_search call inside enrichToolResponse.
 * Configurable via `MINSKY_MCP_MEMORY_ENRICHMENT_TIMEOUT_MS`. Defensive default
 * — sized to let a normal embedding-API + pgvector call complete while bounding
 * the worst case so an accidentally-enabled middleware can't hang a tool call
 * indefinitely (PR #974 R2 BLOCKING).
 */
const DEFAULT_TIMEOUT_MS = 5000;

export interface EnrichmentOptions {
  k?: number;
  charBudget?: number;
  /** Override the timeout for the memory_search call in milliseconds. */
  timeoutMs?: number;
}

export interface EnrichmentBlock {
  type: "text";
  text: string;
}

/**
 * Returns true when the env-var opt-in is set, enabling the enrichment
 * middleware. Default (env var unset, or set to anything other than `"1"` or
 * `"true"`) is **disabled** — spike wiring must not activate in production
 * unless explicitly opted in.
 *
 * Used both by the dispatcher (early-return when disabled) and by the
 * benchmark script (set the var to `"1"` to measure enriched performance).
 */
export function isEnrichmentEnabled(): boolean {
  const v = process.env.MINSKY_MCP_MEMORY_ENRICHMENT;
  return v === "1" || v === "true";
}

/**
 * Returns true when this tool is in the spike's allowlist.
 */
export function shouldEnrich(toolName: string): boolean {
  return ENRICHMENT_ALLOWLIST.has(toolName);
}

/**
 * Build the search query from tool name + scalar args.
 *
 * Redaction policy:
 * - Object and array values: redacted (key included as hint, value dropped)
 *   to avoid embedding arbitrarily large payloads.
 * - String values whose KEY matches `SENSITIVE_KEY_PATTERN`: redacted (key
 *   included, value dropped). Bounds data-exposure for future allowlist
 *   expansions (PR #974 R4 BLOCKING #3).
 * - Other primitive scalars: included with key context (`key=value`) for
 *   non-strings; bare value for strings (the value carries its own meaning).
 *
 * The constructed query is hard-capped at MAX_QUERY_LENGTH chars and
 * truncated with an ellipsis if exceeded.
 *
 * Examples:
 * - `("tasks.get", {taskId: "mt#1588"})` → `"tasks.get mt#1588"`
 * - `("session.list", {})` → `"session.list"`
 * - `("tool", {filter: {status: "DONE"}})` → `"tool filter"` (object redacted)
 * - `("tool", {token: "sk-abc"})` → `"tool token"` (sensitive-key redacted)
 * - `("tool", {retries: 3})` → `"tool retries=3"` (non-string scalar)
 */
export function buildQuery(toolName: string, args: Record<string, unknown>): string {
  const argParts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string") {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        // Sensitive key — redact the value.
        argParts.push(k);
      } else {
        argParts.push(v);
      }
    } else if (typeof v === "number" || typeof v === "boolean") {
      argParts.push(`${k}=${String(v)}`);
    } else {
      argParts.push(k);
    }
  }
  const raw = [toolName, ...argParts].join(" ").trim();
  if (raw.length <= MAX_QUERY_LENGTH) return raw;
  return `${raw.slice(0, MAX_QUERY_LENGTH - 1)}…`;
}

/**
 * Format a single memory search result as a compact text snippet.
 */
function formatResult(result: MemorySearchResult, charBudget: number): string {
  const { record, score } = result;
  const header = `[${record.type}] ${record.name} — score ${score.toFixed(2)}`;
  const body = record.description ?? record.content ?? "";
  const snippetBudget = Math.max(0, charBudget - header.length - 4);
  const snippet =
    body.length > snippetBudget ? `${safeTruncate(body, snippetBudget - 1, "head")}…` : body;
  return `${header}\n  ${snippet}`;
}

/**
 * Build the enrichment block from search results. Returns null when there are
 * no results to surface (post-budget filtering).
 */
function buildBlock(
  toolName: string,
  results: MemorySearchResult[],
  charBudget: number
): EnrichmentBlock | null {
  if (results.length === 0) return null;

  const envelope = `<memory-context tool="${toolName}" count="${results.length}">\n`;
  const closing = `\n</memory-context>`;
  let bodyBudget = charBudget - envelope.length - closing.length;
  if (bodyBudget <= 0) return null;

  const lines: string[] = [];
  for (const result of results) {
    const line = formatResult(result, PER_RESULT_CHAR_BUDGET);
    if (line.length + 1 > bodyBudget) {
      if (bodyBudget > 50) {
        lines.push(`${line.slice(0, bodyBudget - 2)}…`);
      }
      break;
    }
    lines.push(line);
    bodyBudget -= line.length + 1;
  }

  if (lines.length === 0) return null;
  return {
    type: "text",
    text: `${envelope}${lines.join("\n")}${closing}`,
  };
}

/**
 * Read the timeout from env (positive integer ms) or fall back to the default.
 * Exported so tests can exercise the parsing.
 */
export function readTimeoutMs(): number {
  const raw = process.env.MINSKY_MCP_MEMORY_ENRICHMENT_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

/**
 * Run the memory enrichment middleware against a tool call.
 *
 * Returns an additional content block to append to the tool response, or
 * null when:
 * - The env-var opt-in is not set (default state — spike does not activate)
 * - The tool is not allowlisted
 * - The memory service is unavailable
 * - The search fails, returns degraded results, or exceeds the configured timeout
 * - The result set is empty after token-budget filtering
 *
 * Errors and timeouts are logged at debug level and never propagated —
 * enrichment failure must NEVER break the underlying tool call.
 */
export async function enrichToolResponse(
  toolName: string,
  args: Record<string, unknown>,
  memoryService: MemoryServiceSurface | undefined,
  options: EnrichmentOptions = {}
): Promise<EnrichmentBlock | null> {
  if (!isEnrichmentEnabled()) return null;
  if (!shouldEnrich(toolName)) return null;
  if (!memoryService) return null;

  const k = options.k ?? DEFAULT_K;
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET;
  const timeoutMs = options.timeoutMs ?? readTimeoutMs();
  const query = buildQuery(toolName, args);
  if (!query) return null;

  // Bound the search call so an accidentally-enabled middleware can't hang
  // the dispatcher indefinitely. Tagged-union discriminant on the race
  // outcome (PR #974 R3 BLOCKING) — avoids the prior Symbol-sentinel
  // pattern that relied on TypeScript inference rather than an explicit
  // runtime shape check. Timeout handle is cleared on the success path so
  // the timer doesn't outlive the call.
  type RaceOutcome =
    | { kind: "ok"; response: Awaited<ReturnType<MemoryServiceSurface["search"]>> }
    | { kind: "timeout" };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const searchPromise: Promise<RaceOutcome> = memoryService
      .search(query, { limit: k })
      .then((response) => ({ kind: "ok" as const, response }));
    const timeoutPromise = new Promise<RaceOutcome>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ kind: "timeout" as const }), timeoutMs);
    });
    const outcome = await Promise.race([searchPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (outcome.kind === "timeout") {
      log.debug("[memory-enrichment] search timed out; skipping", {
        tool: toolName,
        timeoutMs,
      });
      return null;
    }
    if (outcome.response.degraded) {
      log.debug("[memory-enrichment] search degraded; skipping", {
        tool: toolName,
        backend: outcome.response.backend,
      });
      return null;
    }
    return buildBlock(toolName, outcome.response.results, charBudget);
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    log.debug("[memory-enrichment] search failed; skipping", {
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
