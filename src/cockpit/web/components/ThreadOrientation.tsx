/**
 * Orientation chrome for the conversation thread (mt#3688).
 *
 * Everything the thread renders to answer "where am I?" rather than "what was
 * said?". {@link ThreadStartBoundary} names what is above the oldest rendered
 * turn, {@link ThreadPositionPill} keeps the reader's position in the whole
 * transcript on screen, and {@link TurnSeparatorRow} marks day boundaries and
 * long pauses between turns.
 *
 * @see ../widgets/ConversationView.tsx — the consumer
 * @see ../hooks/useThreadWindow.ts — the state these render
 */
import type { RefObject } from "react";
import { cn } from "../lib/utils";
import { formatLocalDay, type TurnSeparator } from "../lib/conversation-timeline";
import { formatThreadPosition } from "../lib/scroll-pinning";

/**
 * A day boundary or a long-gap marker between two turns. Renders as a quiet
 * rule with a centered label — it is orientation, not content, so it must not
 * compete with the turns on either side.
 */
export function TurnSeparatorRow({ separator }: { separator: TurnSeparator }) {
  const isDay = separator.kind === "day";
  return (
    <div
      className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground/70"
      data-testid={isDay ? "turn-day-divider" : "turn-gap-divider"}
    >
      <span className="h-px flex-1 bg-border" />
      <span className={cn("tabular-nums", isDay && "font-medium text-muted-foreground")}>
        {isDay ? separator.label : `${separator.label} gap`}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * What sits above the oldest rendered turn.
 *
 * Exactly one of five things renders, always — and that totality is the point.
 * Before mt#3688 the top of a fully-revealed thread was simply blank, so "this
 * is the first message of the conversation" and "there is more above, still
 * coming" were the same picture, and the operator had no way to tell which one
 * they were looking at. Naming every state costs one row and removes the
 * ambiguity outright.
 *
 * ## The two states are about DIFFERENT things (mt#4263)
 *
 * `hiddenBefore` counts turns the client HAS and has not mounted — a render
 * budget. `unfetchedBefore` counts turns the SERVER has and the client has not
 * asked for — a fetch budget. Until mt#4263 only the first existed, because the
 * client always held the whole transcript.
 *
 * Keeping them separate is not tidiness. Collapsing them would put this
 * component back in exactly the state its own history warns about: with the
 * window applied, a reader who has mounted everything they fetched is at
 * `hiddenBefore === 0` while 2,186 turns still sit on the server, and the old
 * three-state version answers that with "Beginning of conversation" — the same
 * false picture, arrived at by a different route.
 */
export function ThreadStartBoundary({
  hiddenBefore,
  isRevealing,
  revealingCount,
  firstTurnAt,
  onRevealOlder,
  onRevealFromStart,
  unfetchedBefore = 0,
  isLoadingOlder = false,
  onLoadOlder,
}: {
  hiddenBefore: number;
  isRevealing: boolean;
  revealingCount: number;
  firstTurnAt: string | undefined;
  onRevealOlder: () => void;
  onRevealFromStart: () => void;
  /**
   * Turns the SERVER still holds beyond what has been fetched (mt#4263).
   * `0` — the default — is the pre-window behaviour: the client has everything.
   */
  unfetchedBefore?: number;
  /** A fetch for older turns is in flight. */
  isLoadingOlder?: boolean;
  /** Fetch the next page of older turns. Absent when the host does not window. */
  onLoadOlder?: () => void;
}) {
  if (isRevealing) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground"
        data-testid="thread-revealing"
        role="status"
      >
        <span className="h-3 w-3 animate-spin rounded-full border border-border border-t-foreground/60" />
        {/* The COUNT is the informative half: it separates "one chunk is
            mounting" from "the whole transcript is mounting", which are very
            different waits and the reason a jump-to-the-beginning announces
            itself at all. */}
        <span className="tabular-nums">
          Revealing {revealingCount} older {revealingCount === 1 ? "turn" : "turns"}…
        </span>
      </div>
    );
  }

  if (isLoadingOlder) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground"
        data-testid="thread-loading-older"
        role="status"
      >
        <span className="h-3 w-3 animate-spin rounded-full border border-border border-t-foreground/60" />
        {/* Deliberately worded as FETCHING, not revealing. The two waits have
            different causes and different durations — one is a render, the
            other is a round trip — and a reader who sees the same copy for both
            cannot tell a slow network from a slow mount. */}
        <span>Loading earlier turns…</span>
      </div>
    );
  }

  if (hiddenBefore > 0) {
    return (
      <div
        className="flex items-center gap-3 py-2 text-[11px] text-muted-foreground/80"
        data-testid="thread-hidden-above"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="tabular-nums">
          {hiddenBefore} earlier {hiddenBefore === 1 ? "turn" : "turns"}
        </span>
        {/* Scrolling up reveals these automatically. The two buttons are the
            fallback for a host where the thread never overflows — there is no
            scroll to ride, so a reader with no control would be stranded. */}
        <button
          type="button"
          onClick={onRevealOlder}
          className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          show more
        </button>
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={onRevealFromStart}
          className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          jump to the beginning
        </button>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  if (unfetchedBefore > 0 && onLoadOlder) {
    return (
      <div
        className="flex items-center gap-3 py-2 text-[11px] text-muted-foreground/80"
        data-testid="thread-unfetched-above"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="tabular-nums">
          {unfetchedBefore} earlier {unfetchedBefore === 1 ? "turn" : "turns"} not loaded
        </span>
        <button
          type="button"
          onClick={onLoadOlder}
          className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          load earlier turns
        </button>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-3 py-2 text-[11px] text-muted-foreground/70"
      data-testid="thread-start"
    >
      <span className="h-px flex-1 bg-border" />
      <span>
        Beginning of conversation
        {firstTurnAt ? ` — ${formatLocalDay(firstTurnAt)}` : ""}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Where the reader sits in the WHOLE transcript, kept on screen.
 *
 * Lives at the BOTTOM rather than the top, which is not an aesthetic choice:
 * `ConversationView` is layout-agnostic by contract, and its hosts pin their own
 * chrome at `sticky top-0` (`RunDetail.tsx`, at a higher z-index), so a bar
 * stuck to the top of the scrollport would render underneath the host's and be
 * invisible.
 *
 * It does NOT pin itself. Until mt#3843 it carried its own `sticky bottom-2
 * z-10`, on the stated premise that "the bottom edge is the thread's own
 * affordance zone... and needs no knowledge of the host to be correct." mt#3344
 * falsified that by mounting a host-supplied activity strip in the same zone at
 * the same `z-10`; being later in DOM order it painted over this pill, covering
 * 16.5px of its 25px and swallowing the click meant for the `↑ start` button.
 * Positioning is therefore the FOOTER's job now — `ThreadFooter` in
 * `ConversationView.tsx` stacks this, the return-to-newest button, and the
 * host's tail in one flex column. This component only says what it is.
 *
 * The track is the whole conversation: the fill is the reader's position, and
 * the ghosted leading segment is the part not rendered yet. That segment is the
 * honest half of the readout — it is what says "you are near the top of what is
 * loaded, which is nowhere near the beginning."
 */
export function ThreadPositionPill({
  fillRef,
  readoutRef,
  totalTurns,
  hiddenBefore,
  onRevealFromStart,
}: {
  fillRef: RefObject<HTMLSpanElement>;
  readoutRef: RefObject<HTMLSpanElement>;
  totalTurns: number;
  hiddenBefore: number;
  onRevealFromStart: () => void;
}) {
  const unrenderedPercent = totalTurns > 0 ? (hiddenBefore / totalTurns) * 100 : 0;
  return (
    <div
      // Pointer-events off so the pill never eats a click meant for the turn it
      // floats over; the controls inside opt back in.
      className="pointer-events-none ml-auto flex w-fit items-center gap-2 rounded-full border border-border bg-card/95 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm"
      data-testid="thread-position"
    >
      <span className="relative block h-1 w-24 overflow-hidden rounded-full bg-muted">
        {/* Width is written imperatively on scroll — see `paintPosition`. */}
        <span ref={fillRef} className="absolute inset-y-0 left-0 w-full bg-foreground/50" />
        {unrenderedPercent > 0 && (
          <span
            className="absolute inset-y-0 left-0 border-r border-border bg-background/75"
            style={{ width: `${unrenderedPercent.toFixed(2)}%` }}
            data-testid="thread-position-unrendered"
          />
        )}
      </span>
      <span ref={readoutRef} className="tabular-nums" data-testid="thread-position-readout">
        {formatThreadPosition(totalTurns, totalTurns)}
      </span>
      <button
        type="button"
        onClick={onRevealFromStart}
        disabled={hiddenBefore === 0}
        className="pointer-events-auto rounded-full px-1 transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
        aria-label="Jump to the beginning of the conversation"
        title="Jump to the beginning of the conversation"
      >
        ↑ start
      </button>
    </div>
  );
}
