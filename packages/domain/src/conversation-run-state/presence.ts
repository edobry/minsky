/**
 * Conversation presence derivation (mt#3201, mt#3130 Phase 2).
 *
 * The read-time half of the run-state channel. mt#3161 records what the harness
 * OBSERVED (`conversation_run_state`); this module turns those observations plus
 * elapsed time into the principal-facing Presence value.
 *
 * ## Why this is derived, never stored
 *
 * `conversation-run-state-schema.ts` deliberately has **no `presence` column**:
 * a stored `presence = 'LIVE'` is a claim no writer can retract when the process
 * dies mid-tool-call. Presence is therefore computed from the observations plus
 * `now` — the same inputs, at any later moment, yield the corrected answer for
 * free.
 *
 * This function is PURE and synchronous — no I/O, injected clock — so it is
 * unit-testable across the whole state space, and so the read path and the
 * absence-detection sweep can call the SAME derivation. Two derivations of
 * "is this conversation live" would drift, which is the failure mt#3130's
 * `NEEDS INPUT` criterion exists to prevent.
 *
 * @see packages/domain/src/storage/schemas/conversation-run-state-schema.ts
 * @see mt#3130 — the locked presence/activity/outcome vocabulary
 */
import type { ConversationRunStateRecord } from "../storage/schemas/conversation-run-state-schema";

/**
 * The principal-facing presence value.
 *
 * mt#3130's chrome vocabulary is `LIVE / NEEDS INPUT / IDLE / ENDED / UNKNOWN`
 * and places `Stalled` in the per-turn OUTCOME register. `STALLED` appears here
 * as well because the umbrella's own acceptance test states the chrome
 * requirement directly — *"Kill an agent's process mid-tool-call; within one
 * sweep interval the conversation reads `Stalled`, not `LIVE`"* — and none of
 * the other four values can honestly carry that case:
 *
 *  - `LIVE` is the false claim being corrected.
 *  - `IDLE` asserts the turn completed, which is exactly what did NOT happen.
 *  - `ENDED` asserts an observed end; a killed process observes nothing.
 *  - `UNKNOWN` means "no telemetry for this conversation" — but there IS
 *    telemetry here, and it is what tells us the work was interrupted.
 *
 * So `STALLED` is "we last saw it mid-work, and it has been quiet past the
 * threshold" — strictly more informative than any of the five, and the only
 * one that is not a lie.
 */
export type ConversationPresence =
  | "LIVE"
  | "NEEDS_INPUT"
  | "IDLE"
  | "STALLED"
  | "ENDED"
  | "UNKNOWN";

/**
 * Why a conversation is waiting on a human. Sourced from the harness signal
 * recorded in `needs_input_reason` (`PermissionRequest` / `Notification`), or
 * from an open Ask joined in by the read path.
 *
 * mt#3130 decision (2) makes this sub-label MANDATORY whenever presence is
 * `NEEDS_INPUT` — never optional — which is why the derivation returns it
 * alongside the value rather than leaving callers to infer it.
 */
export type NeedsInputReason =
  | "permission"
  | "idle-prompt"
  | "agent-needs-input"
  | "ask"
  | "unknown";

/** The full read-time answer for one conversation. */
export interface ConversationPresenceResult {
  presence: ConversationPresence;
  /** Present exactly when `presence === "NEEDS_INPUT"`. */
  needsInputReason: NeedsInputReason | null;
  /** Tool that triggered a `PermissionRequest`, when the harness reported one. */
  needsInputTool: string | null;
  /** In-flight tool name — present only under `LIVE`/`STALLED` with a running tool. */
  toolName: string | null;
  /**
   * Elapsed ms for the in-flight tool call. mt#3130 makes elapsed time MANDATORY
   * rather than optional under `LIVE` — a bare indeterminate spinner is a
   * measurably weaker signal (Myers 1985).
   */
  toolElapsedMs: number | null;
  /** Ms since the last observed event of any kind. Null when there is no row. */
  quietForMs: number | null;
  /**
   * True once `quietForMs` exceeds the silence threshold, for the
   * `· quiet 12m` modifier mt#3130 appends to `IDLE`/`NEEDS INPUT`.
   */
  isQuiet: boolean;
  /** Which observation decided the value — for logs and for explaining the render. */
  basis: "no-row" | "needs-input" | "activity-fresh" | "activity-stale" | "stopped" | "session-end";
}

/**
 * How long a conversation last observed mid-work (`activity` = `running` or
 * `thinking`) may stay quiet before it reads `STALLED` instead of `LIVE`.
 *
 * **Grounded in measured cadence, not chosen as a round number** (per
 * `decision-defaults.mdc §Thresholds`). Basis: 36,310 consecutive inter-turn
 * gaps over 7 days of `agent_transcript_turns` (2026-07-24) —
 * **p50 1s, p90 27s, p99 1436s**. This constant is that p99.
 *
 * Turn grain is strictly COARSER than hook-event grain (hook events fire per
 * tool call, several per turn), so a threshold at the turn-grain p99 is
 * conservative in the safe direction: it cannot false-flag a working
 * conversation more often than 1-in-100, and in practice much less.
 *
 * Deliberately NOT rounded to "25 minutes" — the rounding would discard the
 * only thing that makes the number defensible.
 */
export const PRESENCE_STALL_THRESHOLD_MS = 1_436_000;

/**
 * When to append mt#3130's `· quiet Nm` modifier to `IDLE` / `NEEDS_INPUT`.
 * Same measured basis as above at the p90 (27s) x 10 — long enough that an
 * ordinary between-turns pause does not decorate every idle conversation,
 * short enough to answer "stuck, or just quiet?" within a few minutes.
 */
export const PRESENCE_QUIET_THRESHOLD_MS = 270_000;

/** Injectable thresholds so callers and tests can vary them without patching. */
export interface PresenceThresholds {
  stallThresholdMs?: number;
  quietThresholdMs?: number;
}

/**
 * The `needs_input_reason` values the harness writes, mapped to the
 * principal-facing sub-label. `permission_request` is the sentinel
 * `event-mapping.ts` stores for a `PermissionRequest` event; the rest are
 * `Notification` matchers stored verbatim.
 */
function mapNeedsInputReason(raw: string): NeedsInputReason {
  switch (raw) {
    case "permission_request":
    case "permission_prompt":
      return "permission";
    case "idle_prompt":
      return "idle-prompt";
    case "agent_needs_input":
      return "agent-needs-input";
    default:
      return "unknown";
  }
}

/**
 * Derive presence for one conversation.
 *
 * `row` is null when no `conversation_run_state` row exists — a conversation
 * outside hook coverage. That is `UNKNOWN`, NOT `ENDED` and NOT blank: mt#3130's
 * cross-cutting finding is that a falsely-confident derived field is worse than
 * an absent one (Lee & See 2004), and "we have no telemetry for this" is a
 * different, honest answer.
 *
 * ## Why `ENDED` is never derived from silence alone
 *
 * `ended_hint_at` is a HINT: `/exit` and `/clear` do not fire `SessionEnd`
 * (ADR-017; Claude Code issues #17885, #6428), so its ABSENCE proves nothing.
 * The symmetric point is what this function acts on — silence proves nothing
 * about ending EITHER. A conversation that finished a turn and went quiet for a
 * week is reported `IDLE · quiet 7d`, not `ENDED`: "last we observed, it had
 * completed a turn, and that was a week ago" is true, whereas "it ended" is a
 * claim nothing observed. `ENDED` is reserved for an observed `SessionEnd` with
 * no later event — and a later event un-ends it, which is what makes a
 * `reason: "resume"` restart read correctly.
 *
 * This deliberately requires only ONE time threshold (the measured stall
 * window). An `ENDED`-from-silence rule would need a second threshold with no
 * measurement behind it; declining to invent one is the honest option.
 */
export function derivePresence(
  row: ConversationRunStateRecord | null,
  now: Date,
  thresholds: PresenceThresholds = {}
): ConversationPresenceResult {
  const stallThresholdMs = thresholds.stallThresholdMs ?? PRESENCE_STALL_THRESHOLD_MS;
  const quietThresholdMs = thresholds.quietThresholdMs ?? PRESENCE_QUIET_THRESHOLD_MS;

  if (!row) {
    return {
      presence: "UNKNOWN",
      needsInputReason: null,
      needsInputTool: null,
      toolName: null,
      toolElapsedMs: null,
      quietForMs: null,
      isQuiet: false,
      basis: "no-row",
    };
  }

  const nowMs = now.getTime();
  // Clamped at 0: a future-dated `last_event_at` (clock skew between the hook
  // host and the reader) must not render a negative quiet duration.
  const quietForMs = Math.max(0, nowMs - row.lastEventAt.getTime());
  const isQuiet = quietForMs > quietThresholdMs;
  const stale = quietForMs > stallThresholdMs;

  const toolElapsedMs =
    row.toolStartedAt === null ? null : Math.max(0, nowMs - row.toolStartedAt.getTime());

  const base = {
    needsInputReason: null,
    needsInputTool: null,
    toolName: null,
    toolElapsedMs: null,
    quietForMs,
    isQuiet,
  };

  // ── Waiting on a human ────────────────────────────────────────────────────
  // Checked BEFORE staleness: waiting on a human IS the desired state, and it
  // is quiet by nature. Applying the stall window here would flag every
  // permission prompt the operator hasn't answered within ~24 minutes — the
  // same false-positive shape mt#3193 fixed for IN-REVIEW dispatches.
  // `event-mapping.ts` clears this column on the next forward-progress event,
  // so a stale value cannot outlive the wait.
  if (row.needsInputReason !== null) {
    return {
      ...base,
      presence: "NEEDS_INPUT",
      needsInputReason: mapNeedsInputReason(row.needsInputReason),
      needsInputTool: row.needsInputTool,
      basis: "needs-input",
    };
  }

  // ── Observed end ──────────────────────────────────────────────────────────
  // Only when nothing has been observed SINCE the SessionEnd. A later event
  // means the conversation resumed, and `last_event_at` moving past
  // `ended_hint_at` is exactly how that shows up.
  if (row.endedHintAt !== null && row.lastEventAt.getTime() <= row.endedHintAt.getTime()) {
    return { ...base, presence: "ENDED", basis: "session-end" };
  }

  // ── Mid-work ──────────────────────────────────────────────────────────────
  if (row.activity === "running" || row.activity === "thinking") {
    if (stale) {
      // Nothing retracts a `running` row when the process dies — the write path
      // clears `activity` only on Stop/StopFailure/SessionEnd, none of which a
      // killed process emits. Absence-detection is the only correction.
      return {
        ...base,
        presence: "STALLED",
        toolName: row.toolName,
        toolElapsedMs,
        basis: "activity-stale",
      };
    }
    return {
      ...base,
      presence: "LIVE",
      toolName: row.toolName,
      toolElapsedMs,
      basis: "activity-fresh",
    };
  }

  // ── Turn complete, or no activity-bearing event yet ───────────────────────
  // `IDLE` regardless of how long the silence has run (see the header): a row
  // exists, so we DO have telemetry; the last thing we observed was a completed
  // turn. The `quiet` modifier carries the duration instead of a manufactured
  // `ENDED`.
  return {
    ...base,
    presence: "IDLE",
    basis: row.activity === "idle" ? "stopped" : "activity-fresh",
  };
}
