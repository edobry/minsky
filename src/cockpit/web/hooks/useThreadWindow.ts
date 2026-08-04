/**
 * The conversation thread's render window and the reader's position in it
 * (mt#3688).
 *
 * Extracted from `ConversationView` rather than written there because the two
 * concerns it holds — how much of the transcript is mounted, and where the
 * viewport sits in the whole of it — are one mechanism with one piece of state,
 * and the component is already 1.5k lines of unrelated rendering.
 *
 * @see ../widgets/ConversationView.tsx — the consumer
 * @see ../lib/scroll-pinning.ts — the pure geometry this composes
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import type { MutableRefObject, RefObject } from "react";
import {
  formatThreadPosition,
  scrollFraction,
  threadPositionFromScroll,
} from "../lib/scroll-pinning";

/**
 * Tail-first window (mt#2433): the measured cost on long sessions is the eager
 * MOUNT of every formatted block (265 blocks / ~1MB took >20s to first content;
 * the snapshot fetch itself is ~1s), so only the most recent INITIAL_TURNS
 * turns render on mount — the chat idiom: the operator cares about the newest
 * exchange.
 *
 * The window is a RENDER budget, not a fetch budget — the whole transcript is
 * already in memory (one snapshot request), so nothing is loading while turns
 * are hidden. mt#3688 made the reveal automatic on scroll for that reason: with
 * no network cost to amortize, asking the operator to click was buying nothing,
 * and the click landed exactly where a reader expects a boundary — so scrolling
 * to the top of a long conversation showed a control instead of its beginning.
 * OLDER_CHUNK bounds how much mounts per reveal; the chunking is what survives
 * of the original mechanism, since it is what the measurement above is about.
 */
export const INITIAL_TURNS = 50;
export const OLDER_CHUNK = 100;

export interface ThreadWindow {
  /** How many turns sit above the rendered window, unmounted. */
  hiddenBefore: number;
  /** True while a reveal's render is in flight. */
  isRevealing: boolean;
  /** How many turns the in-flight reveal is mounting; `0` when none is. */
  revealingCount: number;
  /** Mount the next chunk of older turns, holding the reader's position. */
  revealOlder: () => void;
  /** Mount the whole transcript and go to its first turn. */
  revealFromStart: () => void;
  /** Repaint the position readout against a scrollport. */
  paintPosition: (port: Element | null) => void;
  positionFillRef: RefObject<HTMLSpanElement>;
  positionReadoutRef: RefObject<HTMLSpanElement>;
}

export function useThreadWindow({
  totalTurns,
  sessionKey,
  scrollportRef,
  pinnedRef,
}: {
  /** Every renderable turn in the transcript, hidden ones included. */
  totalTurns: number;
  /** Changing this resets the window back to the tail. */
  sessionKey: string | undefined;
  /** The element that actually scrolls the thread; resolved by the consumer. */
  scrollportRef: MutableRefObject<Element | null>;
  /** The consumer's live-tail pin flag, cleared when a reveal jumps to the top. */
  pinnedRef: MutableRefObject<boolean>;
}): ThreadWindow {
  /**
   * Where the rendered window STARTS, as an index into the turn list — `null`
   * until the operator has revealed anything.
   *
   * The null-vs-index distinction is load-bearing. While `null` the window is
   * DERIVED (`total - INITIAL_TURNS`) and therefore tracks the tail, so a live
   * session appending turns keeps showing the newest fifty — right for a reader
   * who has not scrolled. The first reveal turns it into an INDEX, which stops
   * moving, so later appends cannot push revealed history back out of the
   * window.
   *
   * Before mt#3688 both this and a separate "show all" flag were counts from
   * the TAIL, and `slice(length - count)` shifts forward as the tail grows: each
   * arriving turn silently re-hid one the operator had explicitly asked for. The
   * old "show all" carried a comment about exactly this hazard (PR #1667 R1) and
   * solved it only for itself; an index solves it for both, which is why the two
   * states collapse into this one — "show all" is just `revealedFrom === 0`.
   */
  const [revealedFrom, setRevealedFrom] = useState<number | null>(null);
  const [isRevealing, startReveal] = useTransition();
  /**
   * How many turns the in-flight reveal is mounting.
   *
   * Set OUTSIDE the transition so it commits with the pending render rather than
   * with the reveal it describes — the point is to name the work while it is
   * happening, and a value that arrived with the finished result would say
   * nothing the finished result does not already show.
   */
  const [revealingCount, setRevealingCount] = useState(0);

  // A new session in the same mounted component windows back to the tail.
  useEffect(() => {
    setRevealedFrom(null);
  }, [sessionKey]);

  const hiddenBefore = revealedFrom ?? Math.max(0, totalTurns - INITIAL_TURNS);

  /**
   * The reveal in flight, if any: the scroll height BEFORE it, and whether it
   * was asked to land at the start rather than hold position.
   *
   * A ref rather than state because nothing renders from it and it must survive
   * the transition without scheduling a render of its own.
   */
  const revealPendingRef = useRef<{ previousScrollHeight: number; toStart: boolean } | null>(null);

  /**
   * The window state the callbacks read.
   *
   * Assigned during render, which is safe here precisely because nothing READS
   * it during render — only event handlers and effects do. That is what keeps
   * every callback below stable, so the consumer's scroll listener can stay
   * keyed on its scrollport alone rather than re-binding on every chunk.
   */
  const windowStateRef = useRef({ hiddenBefore, totalTurns });
  windowStateRef.current = { hiddenBefore, totalTurns };

  /**
   * Mount an earlier slice of the transcript.
   *
   * `useTransition` is doing real work here, not decoration. A reveal is a pure
   * state change — every turn is already in memory — so the only cost is React
   * mounting ~100 formatted blocks, which is exactly the cost mt#2433 measured
   * and long enough to feel. The transition keeps the scroll responsive across
   * that render AND makes the interval observable as `isRevealing`, which is
   * what lets the thread's boundary say "revealing" instead of leaving the
   * operator to guess whether the top is the beginning or a stall.
   */
  const reveal = useCallback(
    (nextHiddenBefore: number, toStart: boolean) => {
      if (revealPendingRef.current) return;
      if (nextHiddenBefore >= windowStateRef.current.hiddenBefore) return;
      revealPendingRef.current = {
        previousScrollHeight: scrollportRef.current?.scrollHeight ?? 0,
        toStart,
      };
      setRevealingCount(windowStateRef.current.hiddenBefore - nextHiddenBefore);
      startReveal(() => setRevealedFrom(nextHiddenBefore));
    },
    [scrollportRef]
  );

  const revealOlder = useCallback(() => {
    reveal(Math.max(0, windowStateRef.current.hiddenBefore - OLDER_CHUNK), false);
  }, [reveal]);

  /**
   * Mount the whole transcript and go to its first turn.
   *
   * The ONE interaction allowed to mount everything in a single step, which is
   * why it is a deliberate click and why it announces itself: on the longest
   * transcripts this is the >20s-class render mt#2433 measured, and an operator
   * who chose it should see that it is working rather than a frozen thread.
   */
  const revealFromStart = useCallback(() => reveal(0, true), [reveal]);

  /**
   * Hold the reader's position across a reveal.
   *
   * Content prepended above the viewport pushes everything below it down by its
   * own height, so without a correction the thread jumps by a whole chunk the
   * instant the reveal commits. The web platform has a mechanism for exactly
   * this — CSS scroll anchoring — but per MDN it is unimplemented in WebKit,
   * which is what the tray's macOS window renders in, so it is unavailable on
   * the surface the operator actually reads. The thread therefore sets
   * `[overflow-anchor:none]` and corrects the scroll itself: one code path on
   * every engine, rather than a correction fighting an anchor on some of them
   * and carrying the whole load on others.
   *
   * Gated on the transition having COMMITTED (`!isRevealing`) so the correction
   * measures the thread with the new turns in the DOM, not the render that
   * merely started the reveal.
   *
   * **Known bound.** The correction is a height DELTA, so it assumes every pixel
   * the thread gained during the reveal was added above the reader. On a live
   * session that is not strictly true: a turn arriving at the TAIL inside the
   * same transition is counted too, and the reader is over-scrolled by its
   * height. The error is bounded by whatever arrived in that window — typically
   * one turn — and the reader is already told content arrived (`hasNewBelow`).
   * Anchoring on the previously-oldest turn's offset instead would be immune,
   * and is the move if this is ever observed to matter; it is not worth the DOM
   * bookkeeping for a case that needs an append to land inside a ~100ms window
   * while the operator is reading history.
   */
  useLayoutEffect(() => {
    const pending = revealPendingRef.current;
    if (!pending) return;
    const port = scrollportRef.current;

    if (isRevealing) {
      // The transition has STARTED but its turns are not mounted yet, so the
      // thread still measures pre-reveal — and this commit is much closer to
      // the one that mounts them than the click was. Re-baselining here shrinks
      // the window in which some OTHER height change (a markdown block settling,
      // an entity link resolving, the boundary row swapping variants) can land
      // above the reader and go uncompensated. Measured against a real
      // transcript, the click-time baseline drifted by up to ~18px; this
      // baseline does not.
      if (port) pending.previousScrollHeight = port.scrollHeight;
      return;
    }

    revealPendingRef.current = null;
    if (!port) return;
    if (pending.toStart) {
      port.scrollTop = 0;
      pinnedRef.current = false;
      return;
    }
    port.scrollTop += port.scrollHeight - pending.previousScrollHeight;
  });

  const positionFillRef = useRef<HTMLSpanElement>(null);
  const positionReadoutRef = useRef<HTMLSpanElement>(null);

  /**
   * Paint where the viewport sits in the whole transcript.
   *
   * Written straight to the DOM rather than through state on purpose: this runs
   * on every scroll frame, and the thread has hundreds of unmemoized turn nodes
   * mounted below it, so a `setState` here would re-render all of them per
   * frame. Nothing else reads these two values, so nothing else needs them in
   * the React tree.
   */
  const paintPosition = useCallback((port: Element | null) => {
    const { hiddenBefore: hidden, totalTurns: total } = windowStateRef.current;
    const position = threadPositionFromScroll(scrollFraction(port), hidden, total);
    if (positionFillRef.current) {
      // Drawn against the WHOLE transcript, deliberately NOT against the scroll
      // range. Those are different scales, and the track already carries the
      // unrendered region on the transcript scale — painting the fill on the
      // scroll scale put two rulers on one bar, so a reader 90% through the
      // MOUNTED turns appeared to be standing inside the region that is not
      // mounted. On this scale the fill meets the ghosted segment exactly when
      // the reader reaches the oldest rendered turn, which is what it means.
      const percent = total > 0 ? (position / total) * 100 : 100;
      positionFillRef.current.style.width = `${percent.toFixed(2)}%`;
    }
    if (positionReadoutRef.current) {
      positionReadoutRef.current.textContent = formatThreadPosition(position, total);
    }
  }, []);

  // Repaint after every commit — a reveal changes the scroll height under the
  // reader, so the fraction moves without any scroll event firing. Declared
  // AFTER the correction above so it measures the corrected position.
  useLayoutEffect(() => {
    paintPosition(scrollportRef.current);
  });

  return {
    hiddenBefore,
    isRevealing,
    revealingCount,
    revealOlder,
    revealFromStart,
    paintPosition,
    positionFillRef,
    positionReadoutRef,
  };
}
