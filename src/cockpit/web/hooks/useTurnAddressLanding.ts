/**
 * Landing on an addressed turn (mt#3791).
 *
 * The conversation thread can be arrived at with one specific turn named — a
 * session-film row links to the action it shows. Serving that address takes
 * three steps that have to happen in order, which is why they live together
 * here rather than scattered through `ConversationView`:
 *
 *   1. RESOLVE the address against what the thread actually renders. A
 *      transcript position is not a render position: turns are filtered
 *      (abandoned rewind branches, empty pairings) and the window slices what
 *      is left.
 *   2. REVEAL far enough back to mount it. The thread opens on the newest
 *      `INITIAL_TURNS`, so an older address names a turn that is not in the DOM
 *      and that no amount of scrolling reaches.
 *   3. LAND on it, once, without fighting the two other mechanisms that want to
 *      own the scroll position (the open-on-newest one-shot, and the window's
 *      post-reveal position correction).
 *
 * Call this AFTER `useThreadWindow` in the consumer: this hook's layout effect
 * must run after that hook's scroll correction, and effect order follows
 * declaration order.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { findAddressedElement, type TurnAddress } from "../lib/conversation-turn-address";

/**
 * Where an address landed.
 *
 * The three cases are deliberately distinct: `null` means no address was given
 * and every existing behavior stands untouched; `"unresolved"` means an address
 * was given and names nothing this thread renders, which the reader must be TOLD
 * rather than left to wonder why nothing happened; a position is the turn to land
 * on, expressed on the same scale the render window works in.
 */
export type AddressResolution = { blockId: string; position: number } | "unresolved" | null;

/** The one field this hook needs off a turn — kept minimal so it stays decoupled. */
type AddressableTurn = { blockId: string };

export function useTurnAddressLanding({
  turnTarget,
  blockIdByTurnIndex,
  visibleTurns,
  hiddenBefore,
  revealTo,
  didInitialScrollRef,
  pinnedRef,
}: {
  /** The address to serve, or `undefined` for an ordinary arrival. */
  turnTarget: TurnAddress | undefined;
  /** Transcript position → block id, built over every renderable block. */
  blockIdByTurnIndex: Map<number, string>;
  /** Every renderable turn, hidden ones included — the scale positions are on. */
  visibleTurns: readonly AddressableTurn[];
  /** Where the render window currently starts. */
  hiddenBefore: number;
  /** `useThreadWindow`'s reveal-to-a-named-index entrypoint. */
  revealTo: (index: number) => void;
  /** The consumer's open-on-newest one-shot, which an address takes over. */
  didInitialScrollRef: MutableRefObject<boolean>;
  /** The consumer's live-tail pin flag; a landing parks the reader in history. */
  pinnedRef: MutableRefObject<boolean>;
}): {
  addressed: AddressResolution;
  /** The resolved position, or `null` for both no-address and unresolved. */
  addressedTurn: { blockId: string; position: number } | null;
  /** Attach to the thread's root — the container the anchor is looked up in. */
  threadRef: MutableRefObject<HTMLDivElement | null>;
} {
  const addressed = useMemo<AddressResolution>(() => {
    if (!turnTarget) return null;
    const blockId = blockIdByTurnIndex.get(turnTarget.turnIndex);
    if (blockId === undefined) return "unresolved";
    const position = visibleTurns.findIndex((turn) => turn.blockId === blockId);
    // The block exists but this thread renders nothing for it — an abandoned
    // rewind branch, or a turn whose only element was filtered as empty. There
    // is no element to land on, so this is as unresolved as a missing index.
    return position < 0 ? "unresolved" : { blockId, position };
  }, [turnTarget, blockIdByTurnIndex, visibleTurns]);

  const addressedTurn = addressed !== null && addressed !== "unresolved" ? addressed : null;

  /**
   * Step 2 — mount the addressed turn when the tail-first window left it out.
   *
   * Runs on every commit while the turn is still hidden rather than once:
   * `revealTo` bails while another reveal is in flight, so re-asking is what
   * guarantees the arrival eventually lands.
   */
  useEffect(() => {
    if (addressedTurn && addressedTurn.position < hiddenBefore) revealTo(addressedTurn.position);
  }, [addressedTurn, hiddenBefore, revealTo]);

  /**
   * Step 3 — land on it.
   *
   * A LAYOUT effect, so the landing happens before paint rather than as a
   * visible jump. `landedRef` holds the address already served, so a later
   * reveal, live append, or expand-all cannot yank the reader back to it — while
   * a NEW address in the same mounted thread does land again.
   */
  const threadRef = useRef<HTMLDivElement | null>(null);
  const landedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!turnTarget || !addressedTurn) return;
    const key = `${turnTarget.turnIndex}:${turnTarget.toolUseId ?? ""}`;
    if (landedRef.current === key) return;
    const container = threadRef.current;
    if (!container) return;
    // Not in the DOM yet — a reveal is still mounting it. Leaving `landedRef`
    // unset is what brings this effect back on the commit that does.
    const element = findAddressedElement(container, turnTarget);
    if (!element) return;
    landedRef.current = key;
    // Take over the open-on-newest one-shot, and say the reader is parked in
    // history — otherwise an arriving turn scrolls the landing out from under
    // them moments after they got here.
    didInitialScrollRef.current = true;
    pinnedRef.current = false;
    element.scrollIntoView({ block: "center" });
  }, [turnTarget, addressedTurn, hiddenBefore, didInitialScrollRef, pinnedRef]);

  return { addressed, addressedTurn, threadRef };
}
