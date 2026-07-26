/**
 * Harness-event → run-state column mapping (mt#3161, mt#3130 Phase 1).
 *
 * A pure function from an observed Claude Code hook event to the set of
 * `conversation_run_state` columns it updates. Deliberately separated from both
 * the HTTP route and the hook:
 *
 *  - **Not in the hook.** The hook is a dumb forwarder that posts the raw
 *    payload. Keeping the mapping server-side means revising it does not
 *    require recompiling and redistributing `.claude/hooks/` to every
 *    dispatched-subagent workspace in the fleet.
 *  - **Not in the route.** A pure `(event, payload) -> patch` function is
 *    directly unit-testable without a DB, an Express app, or a live harness.
 *
 * ## What this maps, and what it deliberately does not
 *
 * Columns record what the harness REPORTED. This function does not decide
 * whether a conversation is `LIVE`, `IDLE`, or `ENDED` — that is a read-time
 * derivation over these observations plus absence-detection (mt#3130 Phase 2),
 * and computing it here would produce exactly the falsely-confident derived
 * field the umbrella exists to eliminate.
 *
 * @see packages/domain/src/storage/schemas/conversation-run-state-schema.ts
 * @see mt#3130 — the locked presence/activity/outcome vocabulary this feeds
 */

/**
 * Coarse activity, derived ONLY from which event fired — never inferred from
 * timing, transcript content, or absence.
 */
export type RunStateActivity = "thinking" | "running" | "idle";

/**
 * The `Notification` matcher values that genuinely mean "waiting on a human".
 * `agent_completed` is deliberately NOT here: it reports completion, not a
 * request for input, and recording it as a needs-input reason would make the
 * console claim the operator is blocking when they are not.
 */
const NEEDS_INPUT_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "permission_prompt",
  "idle_prompt",
  "agent_needs_input",
]);

/** Sentinel stored in `needs_input_reason` for a `PermissionRequest` event. */
export const PERMISSION_REQUEST_REASON = "permission_request";

/**
 * The column patch an event produces. Every field is optional; `null` is a
 * meaningful value meaning "clear this column", distinct from `undefined`
 * meaning "leave it alone".
 */
export interface RunStatePatch {
  activity?: RunStateActivity | null;
  toolName?: string | null;
  toolStartedAt?: Date | null;
  promptId?: string | null;
  needsInputReason?: string | null;
  needsInputTool?: string | null;
  needsInputAt?: Date | null;
  lastErrorType?: string | null;
  lastErrorMessage?: string | null;
  lastErrorAt?: Date | null;
  lastCompactionTrigger?: string | null;
  lastCompactionAt?: Date | null;
  lastCompactionEndedAt?: Date | null;
  endedHintAt?: Date | null;
  endedHintReason?: string | null;
}

/** The raw hook payload, as forwarded by the writer hook. */
export type HookPayload = Record<string, unknown>;

function str(payload: HookPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Clearing needs-input on any forward-progress event is an OBSERVATION, not an
 * inference: the harness only emits `UserPromptSubmit` / `PreToolUse` /
 * `PostToolUse` once the conversation is actually proceeding again, which means
 * whatever it was waiting on has been resolved.
 */
const NEEDS_INPUT_CLEARED: RunStatePatch = {
  needsInputReason: null,
  needsInputTool: null,
  needsInputAt: null,
};

/**
 * Map one observed harness event to its column patch.
 *
 * Returns `null` for an event this channel does not track — an unknown or
 * unregistered event is ignored rather than treated as an error, so adding a
 * `settings.json` registration ahead of a mapping (or a harness version
 * emitting something new) degrades to "no state change", never to a crash or a
 * corrupted row.
 */
export function mapHookEventToRunState(
  eventName: string,
  payload: HookPayload,
  observedAt: Date
): RunStatePatch | null {
  switch (eventName) {
    case "UserPromptSubmit":
      return {
        ...NEEDS_INPUT_CLEARED,
        activity: "thinking",
        promptId: str(payload, "prompt_id") ?? null,
        toolName: null,
        toolStartedAt: null,
      };

    case "PreToolUse":
      return {
        ...NEEDS_INPUT_CLEARED,
        activity: "running",
        toolName: str(payload, "tool_name") ?? null,
        toolStartedAt: observedAt,
        promptId: str(payload, "prompt_id") ?? null,
      };

    case "PostToolUse":
      // The tool finished; the agent is composing again. Recorded as
      // "thinking" rather than left as "running" so a completed call does not
      // read as an in-flight one for the rest of the turn.
      return {
        ...NEEDS_INPUT_CLEARED,
        activity: "thinking",
        toolName: null,
        toolStartedAt: null,
        promptId: str(payload, "prompt_id") ?? null,
      };

    case "Stop":
      return {
        activity: "idle",
        toolName: null,
        toolStartedAt: null,
      };

    case "StopFailure":
      // error_type is stored verbatim — the Rate-limited-vs-Errored split in
      // the mt#3130 vocabulary is the render layer's mapping, not ours.
      return {
        activity: "idle",
        toolName: null,
        toolStartedAt: null,
        lastErrorType: str(payload, "error_type") ?? "unknown",
        lastErrorMessage: str(payload, "error_message") ?? null,
        lastErrorAt: observedAt,
      };

    case "Notification": {
      const type = str(payload, "type");
      if (type && NEEDS_INPUT_NOTIFICATION_TYPES.has(type)) {
        return { needsInputReason: type, needsInputAt: observedAt };
      }
      // Any other matcher (notably `agent_completed`) is a real observation
      // that the conversation is NOT waiting on input.
      return NEEDS_INPUT_CLEARED;
    }

    case "PermissionRequest":
      // The one unambiguous, harness-native source for
      // `NEEDS INPUT (permission)`. Without it the reason sub-label — which
      // mt#3130 decision (2) makes mandatory — would have to be inferred.
      return {
        needsInputReason: PERMISSION_REQUEST_REASON,
        needsInputTool: str(payload, "tool_name") ?? null,
        needsInputAt: observedAt,
      };

    case "PreCompact":
      // `trigger` only. The harness exposes NO token-usage field on this event
      // (mt#3130's build list claimed otherwise; that claim was checked against
      // the hooks reference and is false).
      return {
        lastCompactionTrigger: str(payload, "trigger") ?? "unknown",
        lastCompactionAt: observedAt,
      };

    case "PostCompact":
      return { lastCompactionEndedAt: observedAt };

    case "SessionEnd":
      // A HINT, never authoritative — /exit and /clear do not fire SessionEnd
      // (ADR-017; Claude Code issues #17885, #6428). Absence of this column
      // proves nothing about whether the conversation ended.
      return {
        endedHintAt: observedAt,
        endedHintReason: str(payload, "reason") ?? null,
        toolName: null,
        toolStartedAt: null,
      };

    default:
      return null;
  }
}

/** Every event this channel currently maps — the registration set of record. */
export const OBSERVED_HOOK_EVENTS: readonly string[] = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "StopFailure",
  "Notification",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
];
