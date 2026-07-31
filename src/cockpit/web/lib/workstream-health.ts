/**
 * Workstream health derivation (mt#2885).
 *
 * The supervision spine's middle tier: each stream answers "is this moving,
 * stuck, or blocked on me?" without expansion (/product-thinking: state over
 * history, needs-me over newest, orientation — contextualize against goals).
 *
 * All signals derive render-side from data already flowing: the widget
 * card's lastActivityAt (newest task updatedAt in the stream, mt#2885
 * backend field), child statuses (IN-REVIEW ≙ a PR at review in this
 * lifecycle), and the shared ["asks"] cache joined by parentTaskId — the
 * same join pattern as the fleet table (mt#2884).
 */

export type StreamHealthState = "blocked-on-you" | "stalled" | "awaiting-review" | "moving";

/** Render order: attention-worthiness, not activity volume. */
export const STREAM_HEALTH_RANK: Record<StreamHealthState, number> = {
  "blocked-on-you": 0,
  stalled: 1,
  "awaiting-review": 2,
  moving: 3,
};

/**
 * Stall threshold for streams with active work: status unchanged ≥5 days
 * (decision-defaults §Thresholds — "Stall threshold (status hasn't changed):
 * 5 days for active work").
 */
export const STALL_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000;

/** The card fields health reads — structural subset of WorkstreamCard. */
export interface HealthReadableCard {
  parentId: string;
  children: { id: string; status: string }[];
  lastActivityAt: string | null;
}

export interface StreamHealth {
  state: StreamHealthState;
  /** Open asks bound to this stream (parent or any child). */
  openAskCount: number;
  /** Children currently at review (the PR-at-review proxy in this lifecycle). */
  inReviewCount: number;
  /** Whole days since last motion; null when the stream has no timestamp. */
  daysSinceActivity: number | null;
}

/**
 * Derive a stream's health. Precedence: blocked-on-you (any bound open ask)
 * → stalled (no motion within the threshold) → awaiting-review (any child at
 * IN-REVIEW) → moving.
 */
export function streamHealth(
  card: HealthReadableCard,
  askTaskIds: ReadonlySet<string>,
  now: number = Date.now()
): StreamHealth {
  const streamIds = [card.parentId, ...card.children.map((c) => c.id)];
  const openAskCount = streamIds.filter((id) => askTaskIds.has(id)).length;
  const inReviewCount = card.children.filter((c) => c.status === "IN-REVIEW").length;

  let daysSinceActivity: number | null = null;
  let stalled = false;
  if (card.lastActivityAt) {
    const last = new Date(card.lastActivityAt).getTime();
    if (Number.isFinite(last) && now >= last) {
      const elapsed = now - last;
      daysSinceActivity = Math.floor(elapsed / (24 * 60 * 60 * 1000));
      stalled = elapsed > STALL_THRESHOLD_MS;
    }
  }

  const state: StreamHealthState =
    openAskCount > 0
      ? "blocked-on-you"
      : stalled
        ? "stalled"
        : inReviewCount > 0
          ? "awaiting-review"
          : "moving";

  return { state, openAskCount, inReviewCount, daysSinceActivity };
}
