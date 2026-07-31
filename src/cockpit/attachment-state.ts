/**
 * Row attachment-state categorization for the Agents view (mt#2286).
 *
 * mt#2284 records a session's LIVE runtime attachment(s) (pid-liveness
 * checked) — `listLiveSessionAttachments`. This module reduces that raw
 * attachment set down to the three-value indicator the Agents-view row and
 * the "go to" action both key off of:
 *
 *   - "attached-external": at least one live attachment carries a non-empty
 *     `terminalContext` env bag (TERM_PROGRAM, TMUX_PANE, etc.) — the mt#2285
 *     focus-adapter registry can resolve an adapter for it and raise an OS
 *     terminal tab/pane.
 *   - "in-cockpit": a live attachment exists, but none carries
 *     `terminalContext` — there's a live process attached, but nothing an OS
 *     focus adapter could act on (e.g. attached from a non-terminal
 *     invocation). The "go to" action falls back to in-cockpit navigation.
 *   - "detached": no live attachment at all.
 *
 * This is distinct from the row's `liveness` (activity-recency, mt#951) and
 * the live-tail pulse (`useActiveConversationSessions`, mt#2749) — three
 * different "is this running" signals that answer different questions and
 * are rendered as three separate, deliberately subtle indicators on the row.
 */
import type { SessionAttachment } from "@minsky/domain/session/index";

export type RowAttachState = "attached-external" | "in-cockpit" | "detached";

/** The subset of SessionAttachment fields this module actually reads. */
export type AttachStateInput = Pick<SessionAttachment, "sessionId" | "terminalContext">;

/**
 * Categorize one session's live-attachment set into a {@link RowAttachState}.
 * Pure — no I/O. Callers resolve the live attachment set via
 * `listLiveSessionAttachments` (mt#2284) before calling this.
 */
export function deriveRowAttachState(liveAttachments: AttachStateInput[]): RowAttachState {
  if (liveAttachments.length === 0) return "detached";
  const hasTerminalContext = liveAttachments.some(
    (a) => a.terminalContext && Object.keys(a.terminalContext).length > 0
  );
  return hasTerminalContext ? "attached-external" : "in-cockpit";
}

/**
 * Group a flat live-attachment list (as returned by
 * `listLiveSessionAttachments(repo)` with no `sessionId` filter — i.e. the
 * whole-table batch shape) by `sessionId`, so a widget iterating many rows
 * can look up each row's attachments with one map read instead of N queries.
 */
export function groupAttachmentsBySessionId<T extends AttachStateInput>(
  attachments: T[]
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const attachment of attachments) {
    const existing = map.get(attachment.sessionId);
    if (existing) {
      existing.push(attachment);
    } else {
      map.set(attachment.sessionId, [attachment]);
    }
  }
  return map;
}
