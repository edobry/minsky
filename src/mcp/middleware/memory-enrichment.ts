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

import type { MemoryServiceSurface } from "../../domain/memory/memory-service";
import type { MemorySearchResult } from "../../domain/memory/types";
import { log } from "../../utils/logger";

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
 * Build the search query from tool name + scalar args. Object and array values
 * are redacted (key included, value dropped) to avoid embedding arbitrarily
 * large payloads or sensitive data — only primitive scalar args contribute
 * their values to the query (PR #974 R1 BLOCKING).
 *
 * The constructed query is hard-capped at MAX_QUERY_LENGTH chars and truncated
 * with an ellipsis if exceeded.
 *
 * Examples:
 * - `("tasks.get", {taskId: "mt#1588"})` → `"tasks.get mt#1588"`
 * - `("session.list", {})` → `"session.list"`
 * - `("tool", {filter: {status: "DONE"}})` → `"tool filter"` (object value redacted)
 */
export function buildQuery(toolName: string, args: Record<string, unknown>): string {
  const argParts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string") {
      argParts.push(v);
    } else if (typeof v === "number" || typeof v === "boolean") {
      // Include key context for non-string scalars so retrieval has semantic
      // grounding (PR #974 R2 NON-BLOCKING). String args still carry their
      // own meaning so they're appended bare.
      argParts.push(`${k}=${String(v)}`);
    } else {
      // Redact non-scalar values: include the key as a hint that it was set,
      // but drop the value to avoid leaking unbounded content into the query.
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
  const snippet = body.length > snippetBudget ? `${body.slice(0, snippetBudget - 1)}…` : body;
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

  try {
    // Bound the search call so an accidentally-enabled middleware can't hang
    // the dispatcher indefinitely. Timeout fires return null (silently
    // dropped, like any other failure path).
    const searchPromise = memoryService.search(query, { limit: k });
    const timeoutSignal = Symbol("memory-enrichment-timeout");
    const timeoutPromise = new Promise<typeof timeoutSignal>((resolve) => {
      setTimeout(() => resolve(timeoutSignal), timeoutMs);
    });
    const raced = await Promise.race([searchPromise, timeoutPromise]);
    if (raced === timeoutSignal) {
      log.debug("[memory-enrichment] search timed out; skipping", {
        tool: toolName,
        timeoutMs,
      });
      return null;
    }
    if (raced.degraded) {
      log.debug("[memory-enrichment] search degraded; skipping", {
        tool: toolName,
        backend: raced.backend,
      });
      return null;
    }
    return buildBlock(toolName, raced.results, charBudget);
  } catch (error) {
    log.debug("[memory-enrichment] search failed; skipping", {
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
