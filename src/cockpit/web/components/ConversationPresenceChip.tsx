/**
 * The conversation's run-state readout, split across two mount points
 * (mt#3261 for the readout itself; mt#3344 for the split).
 *
 * - {@link ConversationPresenceChip} — the presence VALUE (`LIVE` / `NEEDS
 *   INPUT` / …, its mandatory reason sub-label, the quiet modifier, the Ask
 *   link). Mounted in the run-detail chrome, which mt#3344 pins, so the answer
 *   to "what is this conversation doing right now?" is readable from every tab
 *   at any scroll position.
 * - {@link ConversationActivityLine} — the Activity sub-line ("Running <tool> ·
 *   <elapsed>"). Mounted at the TAIL of the Conversation tab.
 *
 * ## Why the split (mt#3344 narrows mt#3130 decision (1))
 *
 * mt#3130 decision (1) put Presence AND Activity in the chrome together: chrome
 * carries the rolled-up current-status answer, the body carries per-turn
 * history. That rationale still holds for the presence VALUE — it is a property
 * of the conversation, not of the transcript, and must stay readable from the
 * Overview and Context tabs where no transcript is rendered.
 *
 * It does not hold for the Activity sub-line. An operator reading "Running
 * <tool>" is following the transcript's bottom edge — the same place the
 * harness itself puts its running indicator — so rendering it in the chrome put
 * the newest turn and the thing producing it at opposite ends of the viewport.
 * Activity therefore renders at the live tail; Presence stays in the chrome.
 *
 * Both components read the SAME query key (`["conversation", id, "presence"]`),
 * so mounting them separately costs no extra request — TanStack Query dedupes
 * identical keys under one QueryClient.
 *
 * ## What this deliberately does NOT do
 *
 * It never renders a confident value it cannot evidence. The four outcomes the
 * presence route distinguishes stay distinguished here: a store that could not
 * be reached reads "presence unavailable", NOT `UNKNOWN`; a workspace id in a
 * conversation URL reads as a wrong-id-space mistake, NOT "no telemetry"; and a
 * null `ask` is never rendered as "no open asks" (the join only resolves for
 * conversations that have a `minsky_session_links` row).
 *
 * @see ../hooks/useConversationPresence.ts — the read + its four outcomes
 * @see ../lib/conversation-presence-display.ts — the pure presentation rules
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import {
  useConversationPresence,
  type ConversationPresenceState,
} from "../hooks/useConversationPresence";
import {
  PRESENCE_LABEL,
  PRESENCE_TONE,
  describeActivity,
  describeSilence,
  needsInputReasonLabel,
} from "../lib/conversation-presence-display";

/**
 * The activity elapsed value and the quiet modifier both advance between
 * polls, so the readout re-renders once a second while either is on screen.
 * Idle/ended conversations mount no interval at all.
 */
const TICK_MS = 1_000;

function needsTicking(state: ConversationPresenceState | undefined): boolean {
  if (state?.kind !== "presence") return false;
  const { presence, isQuiet } = state.payload;
  if (presence === "LIVE" || presence === "STALLED") return true;
  return isQuiet && (presence === "IDLE" || presence === "NEEDS_INPUT");
}

function useTickingNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/** A muted single-line readout used by every non-`presence` outcome. */
function PresenceNotice({ text, title }: { text: string; title?: string }) {
  return (
    <div
      className="text-xs text-muted-foreground"
      title={title}
      data-testid="conversation-presence"
    >
      {text}
    </div>
  );
}

export function ConversationPresenceChip({ conversationId }: { conversationId: string }) {
  const query = useConversationPresence(conversationId);
  const state = query.data;
  const now = useTickingNow(needsTicking(state));

  if (query.isLoading) {
    return <PresenceNotice text="Reading presence…" />;
  }

  if (query.isError) {
    return <PresenceNotice text="Presence check failed." title={query.error?.message} />;
  }

  if (!state) return null;

  // "We could not look" — never collapsed into UNKNOWN ("we looked, nothing there").
  if (state.kind === "store-unavailable") {
    return (
      <PresenceNotice
        text="Presence unavailable — the run-state store could not be reached."
        title="The presence endpoint returned 503. This is not the same as having no telemetry."
      />
    );
  }

  if (state.kind === "wrong-id-space") {
    return <PresenceNotice text={state.message} />;
  }

  if (state.kind === "invalid-id") {
    return <PresenceNotice text={state.message} />;
  }

  const { payload, fetchedAtMs } = state;
  const silence = describeSilence(payload, fetchedAtMs, now);
  const reason = needsInputReasonLabel(payload);

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
      data-testid="conversation-presence"
    >
      <span
        className={cn("font-semibold uppercase tracking-wide", PRESENCE_TONE[payload.presence])}
        data-testid="conversation-presence-value"
      >
        {PRESENCE_LABEL[payload.presence]}
      </span>

      {reason && (
        <span className="text-muted-foreground" data-testid="conversation-presence-reason">
          ({reason})
        </span>
      )}

      {silence && (
        <span className="text-muted-foreground/70" data-testid="conversation-presence-quiet">
          · {silence}
        </span>
      )}

      {/* The Ask link belongs to the NEEDS INPUT chip, not to the readout in
          general (PR #2349 R1). `reason` is non-null exactly when presence is
          NEEDS_INPUT, so gating on it keeps the two in lockstep. A LIVE
          conversation can carry a resolvable ask — `foldAskIntoPresence`
          deliberately leaves working conversations alone — but surfacing it
          there would imply the conversation is waiting on the operator when
          it is not. */}
      {reason && payload.ask && (
        <Link
          to={`/ask/${encodeURIComponent(payload.ask.id)}`}
          className="text-primary hover:underline"
          title={payload.ask.title}
        >
          {payload.ask.shortId ?? "open ask"}
        </Link>
      )}
    </div>
  );
}

/**
 * The Activity sub-line, pinned to the bottom edge of the transcript (mt#3344).
 *
 * Renders NOTHING outside the one case it can speak to — a `presence` outcome
 * whose `describeActivity` returns a string. The four non-`presence` outcomes
 * and every "no work in flight" state are already reported by
 * {@link ConversationPresenceChip} in the pinned chrome; repeating them here
 * would be the duplicated readout the split exists to avoid.
 *
 * It does NOT pin itself (mt#3843). It used to carry `sticky bottom-0 z-10`
 * while the host mounted it as a SIBLING of `ConversationView` — which put it
 * in the same stacking context, at the same `z-10`, as the thread's own
 * bottom-pinned controls, and made this strip (last in DOM order, opaquely
 * backgrounded) paint over the thread position pill and take the click meant
 * for its `↑ start` button. The host now passes this through
 * `ConversationView`'s `tail` prop instead, and `ThreadFooter` does the pinning
 * for all three at once.
 *
 * The opaque background stays, and is not decoration: transcript text scrolls
 * underneath this strip.
 */
export function ConversationActivityLine({ conversationId }: { conversationId: string }) {
  const query = useConversationPresence(conversationId);
  const state = query.data;
  const now = useTickingNow(needsTicking(state));

  if (state?.kind !== "presence") return null;

  const activity = describeActivity(state.payload, state.fetchedAtMs, now);
  if (!activity) return null;

  return (
    <div
      className="bg-background pt-1 pb-1 font-mono text-[11px] text-muted-foreground tabular-nums"
      data-testid="conversation-presence-activity"
    >
      {activity}
    </div>
  );
}
