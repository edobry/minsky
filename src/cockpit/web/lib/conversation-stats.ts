/**
 * Conversation activity stats (mt#2792 — Overview tab enrichment).
 *
 * Pure, dependency-light computation over an already-fetched
 * `SessionContextSnapshot`'s blocks: tool-call count, a top-N by-tool
 * breakdown, tool-error count, and a first-user-prompt / last-assistant-
 * message snippet. Deliberately computed CLIENT-SIDE from the snapshot the
 * Conversation tab already fetches (`lib/conversation-snapshot.ts`) rather
 * than a new server endpoint — the snapshot is the same shared query-key
 * data `ConversationView` renders from, so this is dedup'd Overview-tab
 * summary math, not a second read of the transcript substrate.
 *
 * @see mt#2792 — this task
 * @see packages/domain/src/transcripts/conversation-elements.ts — the shared
 *   turn/element parser this builds on
 * @see src/cockpit/web/lib/tool-name.ts — friendly tool-name normalization
 *   (mt#2787), reused here for the breakdown labels
 */
import { snapshotBlocksToConversation } from "@minsky/domain/transcripts/conversation-elements";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { friendlyToolName } from "./tool-name";

/** One entry in the top-N by-tool breakdown, sorted descending by count. */
export interface ToolBreakdownEntry {
  /** Friendly tool label (`friendlyToolName`), e.g. `"minsky · tasks_list"` or `"Bash"`. */
  name: string;
  count: number;
}

export interface ConversationStats {
  /** Total tool-call count across every turn in `blocks`. */
  toolCallCount: number;
  /** Count of tool-result elements with `isError: true`. */
  toolErrorCount: number;
  /** Top-N tools by call count, descending (ties broken alphabetically). */
  toolBreakdown: ToolBreakdownEntry[];
  /** Truncated text of the FIRST user-turn text element, or null if none. */
  firstUserPromptSnippet: string | null;
  /** Truncated text of the LAST assistant-turn text element, or null if none. */
  lastAssistantMessageSnippet: string | null;
}

const DEFAULT_TOP_N = 5;
const SNIPPET_MAX_CHARS = 240;

/** Truncate to `max` chars on a code-point boundary, with a trailing ellipsis. */
function truncateSnippet(text: string, max = SNIPPET_MAX_CHARS): string {
  const trimmed = text.trim();
  const points = Array.from(trimmed);
  if (points.length <= max) return trimmed;
  return `${points.slice(0, max).join("").trimEnd()}…`;
}

/**
 * Compute {@link ConversationStats} from a snapshot's raw blocks.
 *
 * `topN` caps the by-tool breakdown (default 5) — full transcripts can call
 * dozens of distinct tools; the Overview pane only wants the headline set.
 */
export function computeConversationStats(
  blocks: SessionContextSnapshotBlock[],
  opts: { topN?: number } = {}
): ConversationStats {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const turns = snapshotBlocksToConversation(blocks);

  let toolCallCount = 0;
  let toolErrorCount = 0;
  const breakdown = new Map<string, number>();
  let firstUserPromptSnippet: string | null = null;
  let lastAssistantMessageSnippet: string | null = null;

  for (const turn of turns) {
    for (const el of turn.elements) {
      if (el.kind === "tool-call") {
        toolCallCount += 1;
        const label = friendlyToolName(el.name);
        breakdown.set(label, (breakdown.get(label) ?? 0) + 1);
      } else if (el.kind === "tool-result") {
        if (el.isError) toolErrorCount += 1;
      } else if (el.kind === "text") {
        const text = el.text.trim();
        if (!text) continue;
        if (turn.role === "user" && firstUserPromptSnippet === null) {
          firstUserPromptSnippet = truncateSnippet(text);
        }
        if (turn.role === "assistant") {
          // Turns are chronological ascending — the last assignment wins.
          lastAssistantMessageSnippet = truncateSnippet(text);
        }
      }
    }
  }

  const toolBreakdown = Array.from(breakdown.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, topN);

  return {
    toolCallCount,
    toolErrorCount,
    toolBreakdown,
    firstUserPromptSnippet,
    lastAssistantMessageSnippet,
  };
}

/**
 * Duration in ms between `startedAt` and `endRef` (endedAt, or a last-activity
 * fallback). Returns `null` when either timestamp is absent/unparseable, or
 * when the computed span is negative (clock skew / bad data) — callers should
 * render nothing in that case, not a bogus duration.
 */
export function computeDurationMs(startedAt: string | null, endRef: string | null): number | null {
  if (!startedAt || !endRef) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endRef).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = end - start;
  return ms >= 0 ? ms : null;
}
