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
 * - Env-var kill switch (`MINSKY_MCP_MEMORY_ENRICHMENT=0`) for benchmarking
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

export interface EnrichmentOptions {
  k?: number;
  charBudget?: number;
}

export interface EnrichmentBlock {
  type: "text";
  text: string;
}

/**
 * Returns true when the env-var kill switch is set to disable enrichment.
 * Used by the benchmark script to measure baseline-vs-enriched latency on
 * the same code path.
 */
export function isEnrichmentDisabled(): boolean {
  return process.env.MINSKY_MCP_MEMORY_ENRICHMENT === "0";
}

/**
 * Returns true when this tool is in the spike's allowlist.
 */
export function shouldEnrich(toolName: string): boolean {
  return ENRICHMENT_ALLOWLIST.has(toolName);
}

/**
 * Build the search query from tool name + args. Naive stringification — the
 * spike report is supposed to comment on signal-to-noise observed with this
 * shape vs. per-tool query shaping (which is out of scope per spec §3 q2).
 *
 * Examples:
 * - `("tasks.get", {taskId: "mt#1588"})` → `"tasks.get mt#1588"`
 * - `("session.list", {})` → `"session.list"`
 */
export function buildQuery(toolName: string, args: Record<string, unknown>): string {
  const argParts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        return String(v);
      }
      return `${k}=${JSON.stringify(v)}`;
    });
  return [toolName, ...argParts].join(" ").trim();
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
 * Run the memory enrichment middleware against a tool call.
 *
 * Returns an additional content block to append to the tool response, or
 * null when:
 * - The tool is not allowlisted
 * - The env-var kill switch is set
 * - The memory service is unavailable
 * - The search fails or returns degraded results
 * - The result set is empty after token-budget filtering
 *
 * Errors are logged at debug level and never propagated — enrichment failure
 * must NEVER break the underlying tool call.
 */
export async function enrichToolResponse(
  toolName: string,
  args: Record<string, unknown>,
  memoryService: MemoryServiceSurface | undefined,
  options: EnrichmentOptions = {}
): Promise<EnrichmentBlock | null> {
  if (isEnrichmentDisabled()) return null;
  if (!shouldEnrich(toolName)) return null;
  if (!memoryService) return null;

  const k = options.k ?? DEFAULT_K;
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET;
  const query = buildQuery(toolName, args);
  if (!query) return null;

  try {
    const response = await memoryService.search(query, { limit: k });
    if (response.degraded) {
      log.debug("[memory-enrichment] search degraded; skipping", {
        tool: toolName,
        backend: response.backend,
      });
      return null;
    }
    return buildBlock(toolName, response.results, charBudget);
  } catch (error) {
    log.debug("[memory-enrichment] search failed; skipping", {
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
