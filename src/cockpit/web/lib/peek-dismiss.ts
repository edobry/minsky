/**
 * peek-dismiss — decides whether an outside interaction dismisses the peek (mt#4143).
 *
 * Pure and DOM-only: takes an event target, returns a verdict. It is a separate module from
 * `peek.ts` (the controller) for the same reason `peek-codec.ts` is — the decision is the part
 * worth testing directly, and a function that returns a boolean can be tested without rendering
 * anything.
 *
 * ## Why "outside" means outside the ASSEMBLY, not outside a pane
 *
 * `PeekHost` renders each pane as its own Radix dialog layer, and Radix computes its outside
 * events per layer against that layer's own node. So with two panes open, a click on pane B is
 * "outside" pane A and fires pane A's handler. Measured against the real primitive rather than
 * assumed (mt#4143 AT-1, and `mem#1018` on why a source read would not have settled it): a
 * pointerdown inside sibling pane B fired pane A's `onPointerDownOutside` once and pane B's zero
 * times, while a pointerdown on neutral page chrome fired both — the second half being the
 * control that proves the observation discriminates.
 *
 * Dismissing on a bare "outside this pane" would therefore destroy the held-pane comparison view
 * the hold gesture exists to build, the moment the operator clicked the pane beside the one they
 * held.
 *
 * ## The two exemptions
 *
 * 1. **Any peek pane.** Interacting with one pane must never dismiss its siblings — the case
 *    above.
 * 2. **Any entity ref.** An ordinary click on a ref REPLACES the pane's contents and a shift-click
 *    HOLDS it; both currently depend on the outside event not dismissing anything. `EntityRef`'s
 *    own click handler owns what happens next, so this module's only job is to stay out of its way.
 *
 * Everything else — page chrome, the list behind, empty space, the app header — dismisses.
 */

/** Marks a rendered peek pane. Set by `PeekHost` on every `SheetContent`. */
export const PEEK_PANE_ATTR = "data-peek-pane";

/** Marks a rendered entity reference. Set by `EntityRef` on its anchor. */
export const ENTITY_REF_ATTR = "data-entity-ref";

/**
 * Narrows an event target to something `closest()` can be called on.
 *
 * An outside interaction's target can legitimately be a non-Element — `document` when focus
 * leaves the window, a text node in some engines — and `closest` is an Element method. Returning
 * null for those is the correct reading: a target that is not inside any pane or ref is outside.
 */
function asElement(target: EventTarget | null | undefined): Element | null {
  if (!target || typeof (target as Element).closest !== "function") return null;
  return target as Element;
}

/** True when the target sits inside any open peek pane. */
export function isInsidePeekPane(target: EventTarget | null | undefined): boolean {
  return Boolean(asElement(target)?.closest(`[${PEEK_PANE_ATTR}]`));
}

/** True when the target sits inside an entity reference. */
export function isInsideEntityRef(target: EventTarget | null | undefined): boolean {
  return Boolean(asElement(target)?.closest(`[${ENTITY_REF_ATTR}]`));
}

/**
 * True when an outside interaction on this target should dismiss the peek assembly.
 *
 * Note the asymmetry with the exemptions above: a target this function cannot resolve to an
 * Element dismisses, because "not inside anything we exempt" is exactly the dismissing case.
 */
export function shouldDismissPeek(target: EventTarget | null | undefined): boolean {
  return !isInsidePeekPane(target) && !isInsideEntityRef(target);
}

/**
 * Radix's `event.type` for the focus-driven outside event, as observed from the primitive.
 *
 * `onInteractOutside` fires on BOTH the pointer and focus paths and is the only handler that sees
 * both, which is why `PeekHost` wires that one rather than the two path-specific handlers. The
 * two paths are told apart by this `type` string — measured, because Radix's published API
 * reference lists these props without documenting their semantics or their event shape at all
 * (checked 2026-08-14).
 */
export const FOCUS_OUTSIDE_EVENT_TYPE = "dismissableLayer.focusOutside";

/** Pulls the original DOM event's target out of a Radix outside-event. */
export function outsideEventTarget(event: {
  detail?: { originalEvent?: { target?: EventTarget | null } };
}): EventTarget | null {
  return event?.detail?.originalEvent?.target ?? null;
}
