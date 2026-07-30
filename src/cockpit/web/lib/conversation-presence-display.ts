/**
 * Presentation rules for mt#3130's locked presence/activity vocabulary
 * (mt#3261). Pure and clock-injected so the whole state space is unit-testable
 * without mounting React or faking timers.
 *
 * The render splits into three registers that mt#3130 keeps deliberately
 * separate — collapsing them is what produced the confusion the umbrella was
 * filed for:
 *
 *  - **Presence** — exactly one value, always visible.
 *  - **Activity** — a sub-line, rendered only while there is work in flight.
 *  - **Silence modifier** — `· quiet 12m`, appended to a resting presence.
 *
 * Colors are SEMANTIC tokens (`liveness.*`, `warn.amber`), not raw Tailwind
 * palette classes, so this file needs no entry in eslint.config.js's
 * `COCKPIT_STATUS_FILES` allowlist. The `liveness.*` scale already exists for
 * session-liveness indicators and maps onto presence directly.
 */
import type {
  ConversationPresence,
  ConversationPresencePayload,
  NeedsInputReason,
} from "../hooks/useConversationPresence";

/** On-screen text for each presence value. `NEEDS_INPUT` renders spaced. */
export const PRESENCE_LABEL: Record<ConversationPresence, string> = {
  LIVE: "LIVE",
  NEEDS_INPUT: "NEEDS INPUT",
  IDLE: "IDLE",
  STALLED: "STALLED",
  ENDED: "ENDED",
  UNKNOWN: "UNKNOWN",
};

/**
 * Semantic-token tone per presence value. `STALLED` uses `liveness-stale`
 * rather than a destructive/red tone: a stalled conversation is an unknown, not
 * an error, and `docs/design-system.md`'s red-scarcity rule reserves red.
 */
export const PRESENCE_TONE: Record<ConversationPresence, string> = {
  LIVE: "text-liveness-healthy",
  NEEDS_INPUT: "text-warn-amber",
  IDLE: "text-liveness-idle",
  STALLED: "text-liveness-stale",
  ENDED: "text-muted-foreground",
  UNKNOWN: "text-muted-foreground",
};

/**
 * mt#3130 decision (2): the reason sub-label is MANDATORY under `NEEDS INPUT`,
 * never optional — so every reason the domain can produce has a label here,
 * including `unknown` (which still says something honest rather than nothing).
 */
export const NEEDS_INPUT_REASON_LABEL: Record<NeedsInputReason, string> = {
  permission: "permission",
  "idle-prompt": "idle prompt",
  "agent-needs-input": "agent needs input",
  ask: "ask",
  unknown: "reason unreported",
};

/**
 * Compact elapsed rendering. Sub-minute reads in seconds so a fast tool call
 * still visibly advances; past an hour the seconds stop carrying information.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${String(totalSec % 60).padStart(2, "0")}s`;
  const hours = Math.floor(totalMin / 60);
  return `${hours}h ${String(totalMin % 60).padStart(2, "0")}m`;
}

/** Coarser than {@link formatElapsed} — "stuck or just quiet" is a minutes question. */
export function formatQuietFor(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "<1m";
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Advance a server-measured duration to the caller's `nowMs`.
 *
 * The endpoint measures against ITS own clock at request time; between polls
 * the only honest way to keep the readout moving is to add the real wall-clock
 * time elapsed since that measurement landed. This invents nothing — it reports
 * a real measurement plus real elapsed time.
 */
export function advanceFrom(
  measuredMs: number | null,
  fetchedAtMs: number,
  nowMs: number
): number | null {
  if (measuredMs == null) return null;
  return measuredMs + Math.max(0, nowMs - fetchedAtMs);
}

/**
 * The Activity sub-line, or `null` when there is no work in flight to describe.
 *
 * Rendered only under `LIVE` / `STALLED` — the two values that mean "we last
 * saw it mid-work". mt#3130 makes the elapsed value MANDATORY under `LIVE`
 * (Myers 1985: a bare indeterminate spinner is a measurably weaker signal), so
 * a running tool with no measured elapsed still renders the tool name rather
 * than silently degrading to a spinner.
 */
export function describeActivity(
  payload: ConversationPresencePayload,
  fetchedAtMs: number,
  nowMs: number
): string | null {
  if (payload.presence !== "LIVE" && payload.presence !== "STALLED") return null;

  const elapsed = advanceFrom(payload.toolElapsedMs, fetchedAtMs, nowMs);

  if (payload.toolName) {
    const suffix = elapsed == null ? "" : ` · ${formatElapsed(elapsed)}`;
    return `Running ${payload.toolName}${suffix}`;
  }

  // No named tool but still mid-work: the harness observed thinking, not a call.
  return "Thinking…";
}

/**
 * The `· quiet Nm` modifier, or `null` when it does not apply.
 *
 * mt#3130 appends it to `IDLE` / `NEEDS INPUT` only — under `LIVE` the activity
 * line is the more specific answer, and under `STALLED` the presence value
 * already IS the silence claim.
 */
export function describeSilence(
  payload: ConversationPresencePayload,
  fetchedAtMs: number,
  nowMs: number
): string | null {
  if (!payload.isQuiet) return null;
  if (payload.presence !== "IDLE" && payload.presence !== "NEEDS_INPUT") return null;
  const quietFor = advanceFrom(payload.quietForMs, fetchedAtMs, nowMs);
  if (quietFor == null) return null;
  return `quiet ${formatQuietFor(quietFor)}`;
}

/**
 * The mandatory `NEEDS INPUT` reason sub-label. Returns `null` for every other
 * presence value.
 *
 * A `NEEDS_INPUT` payload whose `needsInputReason` is somehow absent still gets
 * a label — falling back to `unknown`'s text rather than rendering the value
 * bare, because decision (2) forbids the bare form outright.
 */
export function needsInputReasonLabel(payload: ConversationPresencePayload): string | null {
  if (payload.presence !== "NEEDS_INPUT") return null;
  const reason = payload.needsInputReason ?? "unknown";
  const label = NEEDS_INPUT_REASON_LABEL[reason] ?? NEEDS_INPUT_REASON_LABEL.unknown;
  // A permission prompt names the tool it is gated on when the harness reported it.
  if (reason === "permission" && payload.needsInputTool) {
    return `${label}: ${payload.needsInputTool}`;
  }
  return label;
}
