/**
 * Conversation presence absence-detection sweep (mt#3201, mt#3130 Phase 2).
 *
 * ## Why a sweep is needed when presence is already derived at read time
 *
 * `derivePresence` corrects a stale `LIVE` for free on any READ — the row plus
 * `now` always yields the right answer. So the sweep is NOT what makes the read
 * path honest. It exists for the things a read cannot do:
 *
 *  1. **Push.** A cockpit page already open on a conversation has nothing to
 *     re-read. Only a transition detected server-side can tell it the
 *     conversation just went `STALLED`.
 *  2. **Other consumers.** `dispatch-watchdog` / `dispatch-recovery-classifier`
 *     and mt#1506 want a transition signal, not a polling contract.
 *
 * ## What it deliberately does NOT do
 *
 * It does not write a `presence` column. `conversation-run-state-schema.ts` has
 * none on purpose: a stored `LIVE` is a claim no writer can retract when the
 * process dies. The sweep DETECTS transitions and emits them; the durable
 * answer stays derived.
 *
 * @see packages/domain/src/conversation-run-state/presence.ts
 */
import { log } from "@minsky/shared/logger";
import {
  derivePresence,
  PRESENCE_STALL_THRESHOLD_MS,
  type ConversationPresence,
} from "@minsky/domain/conversation-run-state/presence";
import type { ConversationRunStateRecord } from "@minsky/domain/storage/schemas/conversation-run-state-schema";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * Postgres NOTIFY channel for a presence transition. Registered in
 * `COCKPIT_SSE_CHANNELS` (routes/events.ts) so the shared `SseBroker` forwards
 * it to subscribed clients.
 */
export const CHANNEL_CONVERSATION_PRESENCE_CHANGED = "minsky.conversation.presence_changed";

/** One detected change, as emitted on the channel above. */
export interface PresenceTransition {
  conversationId: string;
  /** Null when this conversation was not being tracked on the previous tick. */
  from: ConversationPresence | null;
  to: ConversationPresence;
  /** ISO-8601 detection time. */
  at: string;
}

/**
 * Process-lifetime memory of what each quiet conversation last derived to.
 *
 * In-memory rather than persisted on purpose: this is a NOTIFICATION dedupe, not
 * a source of truth. Losing it on restart costs at most a re-seed (which the
 * first-tick rule below makes silent), whereas persisting it would create a
 * second copy of a value the schema deliberately refuses to store.
 */
export interface PresenceSweepState {
  lastKnown: Map<string, ConversationPresence>;
  seeded: boolean;
}

export function createPresenceSweepState(): PresenceSweepState {
  return { lastKnown: new Map(), seeded: false };
}

/** Injected IO so the transition logic is unit-testable without a DB or Postgres. */
export interface PresenceSweepDeps {
  /** Conversations whose last observed event predates `olderThan`. */
  listQuietSince: (olderThan: Date) => Promise<ConversationRunStateRecord[]>;
  /** Best-effort NOTIFY. Failures are logged and swallowed by the caller. */
  emit: (channel: string, payload: string) => Promise<void>;
  now: () => Date;
  /** Override the stall window (tests). */
  stallThresholdMs?: number;
}

/**
 * Run one sweep tick, returning the transitions it emitted.
 *
 * ## First tick after boot seeds silently
 *
 * On a cold start every quiet conversation would otherwise look like a
 * brand-new transition, so the daemon would fire a burst of `STALLED`
 * notifications for conversations that went quiet hours ago and whose state
 * nobody just changed. The first tick therefore records without emitting.
 *
 * ## A conversation that resumes is forgotten, not remembered as stale
 *
 * The tracked set is pruned to whatever the current scan returned. A resumed
 * conversation drops out of the quiet window and out of the map; if it stalls
 * again later it re-enters with no prior entry and (past the first tick) emits
 * — which is the correct signal for the second stall. Keeping it would instead
 * leave a permanently-growing map of every conversation the daemon ever saw.
 */
export async function runPresenceSweepTick(
  state: PresenceSweepState,
  deps: PresenceSweepDeps
): Promise<PresenceTransition[]> {
  const stallThresholdMs = deps.stallThresholdMs ?? PRESENCE_STALL_THRESHOLD_MS;
  const now = deps.now();
  const olderThan = new Date(now.getTime() - stallThresholdMs);

  const rows = await deps.listQuietSince(olderThan);

  const transitions: PresenceTransition[] = [];
  const nextKnown = new Map<string, ConversationPresence>();

  for (const row of rows) {
    const { presence } = derivePresence(row, now, { stallThresholdMs });
    const previous = state.lastKnown.get(row.conversationId) ?? null;
    nextKnown.set(row.conversationId, presence);

    if (!state.seeded) continue;
    if (previous === presence) continue;

    transitions.push({
      conversationId: row.conversationId,
      from: previous,
      to: presence,
      at: now.toISOString(),
    });
  }

  state.lastKnown = nextKnown;
  state.seeded = true;

  for (const transition of transitions) {
    try {
      await deps.emit(CHANNEL_CONVERSATION_PRESENCE_CHANGED, JSON.stringify(transition));
    } catch (err) {
      // Fail-open: the read endpoint is the contract, the push is the
      // enhancement. A NOTIFY failure must never abort the tick or mask the
      // remaining transitions.
      log.warn("[conversation-presence-sweep] notify failed", {
        conversationId: transition.conversationId,
        error: getLoggableErrorSummary(err),
      });
    }
  }

  return transitions;
}
