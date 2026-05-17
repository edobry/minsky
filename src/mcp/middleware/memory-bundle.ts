/**
 * Static memory bundle composer for MCP `instructions` injection (mt#1625 spike).
 *
 * Path 3 of the memory-delivery reframe (mt#1588 spike decision): delivers a
 * static, session-start memory bundle via the MCP SDK's `Server.capabilities
 * .instructions` field at the `initialize` handshake. This is the
 * harness-agnostic primitive — every spec-compliant MCP client honors
 * `instructions` at protocol level.
 *
 * Unlike mt#1588's per-dispatch middleware (cost-prohibitive) and mt#1589's
 * per-prompt-submit hook (Claude Code only), this path pays the compute cost
 * exactly once per server-start, and the resulting content lands at
 * top-of-context where the prompt cache amortizes it most efficiently.
 *
 * ## Bundle shape choice
 *
 * This spike uses shape B: top-K by "always relevant" signal — specifically,
 * feedback + user memories ordered by `accessCount DESC` (most-consulted first).
 * Rationale in the spike report (docs/spikes/mt1625-instructions-memory-injection.md):
 * - Feedback memories are operationally load-bearing (they encode behavioral
 *   corrections that affect every turn in the session).
 * - Sorting by `accessCount` surfaces what the agent has actually acted on
 *   previously, not just what was recently written.
 * - This is cheaper than shape A (recency sort) for the "always relevant" goal
 *   because a feedback memory created once and accessed 100 times ranks higher
 *   than one created yesterday and never consulted.
 *
 * ## Compute cost
 *
 * No embedding call is needed — the bundle is composed by a simple
 * `memory.list()` query (lexical, not semantic). The ~835ms per-call p50
 * that killed mt#1588 is zero here. Measured latency at startup should be
 * 10–50ms for a cold DB query.
 *
 * ## Token budget
 *
 * Hard cap: DEFAULT_BUNDLE_TOKEN_BUDGET characters (proxy for tokens at
 * ~4 chars/token). Each memory's name + description + truncated content is
 * included up to PER_MEMORY_CHAR_BUDGET. Total bundle length is capped at
 * MAX_BUNDLE_CHARS before attaching to `instructions`.
 *
 * ## Opt-in guard
 *
 * Default: DISABLED. Set `MINSKY_MCP_INSTRUCTIONS_BUNDLE=1` (or `"true"`) to
 * enable. Same pattern as mt#1588's `MINSKY_MCP_MEMORY_ENRICHMENT` env var.
 *
 * @see mt#1625 — this spike
 * @see mt#1588 — per-dispatch middleware spike (rejected; too costly)
 * @see mt#1589 — per-prompt-submit hook (Claude Code only; complement)
 * @see mt#1314 — added `instructions` option to the MCP Server constructor
 */

import type { MemoryServiceSurface } from "../../domain/memory/memory-service";
import type { MemoryRecord } from "../../domain/memory/types";
import { log } from "../../utils/logger";
import { safeTruncate } from "../../utils/safe-truncate";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Top-K memories to include in the bundle. Kept small to stay within the
 * 4000-token budget documented in the spec.
 */
const DEFAULT_K = 20;

/**
 * Hard character cap for the entire instructions bundle text.
 * ~4 chars/token * 3500 tokens = 14000 chars (conservative for non-ASCII).
 */
const MAX_BUNDLE_CHARS = 14_000;

/**
 * Max characters per memory entry (name + description + content snippet).
 * Keeps individual entries from dominating the bundle.
 */
const PER_MEMORY_CHAR_BUDGET = 600;

/**
 * Env-var name for the opt-in guard. Exported so the ESLint rule
 * `custom/no-unregistered-minsky-env-var` can verify it is registered in
 * `environment.ts`.
 */
export const INSTRUCTIONS_BUNDLE_ENV_VAR = "MINSKY_MCP_INSTRUCTIONS_BUNDLE";

// ---------------------------------------------------------------------------
// Opt-in guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the env-var opt-in is set, enabling the instructions
 * bundle. Default (env var unset or set to anything other than `"1"` or
 * `"true"`) is DISABLED — spike wiring must not activate in production
 * unless explicitly opted in.
 */
export function isInstructionsBundleEnabled(): boolean {
  const v = process.env[INSTRUCTIONS_BUNDLE_ENV_VAR];
  return v === "1" || v === "true";
}

// ---------------------------------------------------------------------------
// Bundle composition
// ---------------------------------------------------------------------------

/**
 * Format a single memory record for inclusion in the bundle.
 * Truncates content to keep per-entry size bounded.
 */
function formatMemoryEntry(record: MemoryRecord): string {
  const meta = `[${record.type}/${record.scope}] ${record.name}`;
  const desc = record.description ? `  ${record.description}` : "";
  const content = record.content ?? "";
  const available = Math.max(0, PER_MEMORY_CHAR_BUDGET - meta.length - desc.length - 8);
  // mt#1625 R1 NON-BLOCKING #3: "tail" mode keeps the beginning of the
  // content (title / opening sentences carry the most signal for memory
  // entries) and drops the end. Previous "head" mode preserved the tail
  // which is the wrong direction for this use case.
  const snippet =
    content.length > available
      ? `${safeTruncate(content, Math.max(0, available - 1), "tail")}…`
      : content;
  const parts = [meta, desc, snippet ? `  ${snippet}` : ""].filter(Boolean);
  return parts.join("\n");
}

/**
 * Build the full instructions bundle text from a list of memory records.
 * Wraps in XML-ish tags for agent legibility.
 */
export function buildBundleText(records: MemoryRecord[]): string {
  if (records.length === 0) return "";

  // mt#1625 R1 BLOCKING #1: emit `count` reflecting actual entries included
  // after the character-budget loop, not the input length. Assemble entries
  // first, then build the header with `entries.length` so the metadata
  // contract holds even when records are dropped due to budget capping.
  // The header/footer sizes are stable regardless of `count`'s digits in
  // typical operation (max ~3 digits for our K cap), so we use a fixed-size
  // reservation for the budget calculation.
  const headerTemplate = `<memory-bundle count="000" source="minsky-db">\n`;
  const footer = `\n</memory-bundle>`;
  let bodyBudget = MAX_BUNDLE_CHARS - headerTemplate.length - footer.length;

  const entries: string[] = [];
  for (const record of records) {
    const entry = formatMemoryEntry(record);
    const entryWithSep = `${entry}\n---`;
    if (entryWithSep.length + 1 > bodyBudget) break;
    entries.push(entryWithSep);
    bodyBudget -= entryWithSep.length + 1;
  }

  if (entries.length === 0) return "";
  const header = `<memory-bundle count="${entries.length}" source="minsky-db">\n`;
  return `${header}${entries.join("\n")}${footer}`;
}

/**
 * Compose the static memory bundle for the MCP `instructions` field.
 *
 * Selects memories by type (feedback, user) ordered by accessCount DESC —
 * most-consulted memories first. No embedding call required; this is a
 * simple DB list query.
 *
 * Returns null when:
 * - The opt-in env var is not set (default)
 * - The memory service is unavailable
 * - The list query fails (graceful degradation — bundle is optional)
 * - No memories match the filter
 *
 * Errors are logged at debug level and never propagated — bundle failure
 * must NEVER break server startup.
 */
export async function composeMemoryBundle(
  memoryService: MemoryServiceSurface,
  k: number = DEFAULT_K
): Promise<string | null> {
  if (!isInstructionsBundleEnabled()) return null;

  try {
    // Fetch feedback and user memories, excluding superseded ones.
    // We use separate list calls per type since the list filter only accepts
    // one type at a time, then merge and sort client-side.
    const [feedbackResult, userResult] = await Promise.all([
      memoryService.list({ type: "feedback", excludeSuperseded: true }),
      memoryService.list({ type: "user", excludeSuperseded: true }),
    ]);

    // Merge and sort by accessCount DESC, then updatedAt DESC as tiebreaker.
    const all = [...feedbackResult, ...userResult];
    all.sort((a, b) => {
      const countDiff = (b.accessCount ?? 0) - (a.accessCount ?? 0);
      if (countDiff !== 0) return countDiff;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    const topK = all.slice(0, k);
    if (topK.length === 0) {
      log.debug("[mt#1625] No memories found for instructions bundle");
      return null;
    }

    const bundleText = buildBundleText(topK);
    if (!bundleText) return null;

    log.debug("[mt#1625] Instructions bundle composed", {
      totalMemories: all.length,
      bundledCount: topK.length,
      bundleChars: bundleText.length,
      // Rough token estimate: ~4 chars/token
      estimatedTokens: Math.ceil(bundleText.length / 4),
    });

    return bundleText;
  } catch (error) {
    log.debug("[mt#1625] composeMemoryBundle failed; skipping bundle", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
