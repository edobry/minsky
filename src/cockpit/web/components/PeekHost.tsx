/**
 * PeekHost — renders the open peek panes (mt#3694).
 *
 * Mounted once in `Layout`, inside the router so `usePeek` can read `?peek=`.
 * Renders nothing at all when no pane is open, so it costs an empty render and
 * no DOM on every page that is not being peeked from.
 *
 * ## Why the panes are laid out here rather than portalled
 *
 * Radix's `Portal` is optional, and skipping it is what lets several open
 * panes be ordinary flex siblings in one row. Portalling each pane to
 * `document.body` instead would leave every pane to position itself
 * absolutely and recompute its offset whenever a sibling opens or closes —
 * the layout would have to be re-derived in JS on every pane change, and the
 * held-pane assembly is exactly the case that makes that non-trivial.
 *
 * ## Esc closes ONE pane
 *
 * Every pane is a live non-modal layer, so an unqualified Esc would dismiss
 * them all at once — losing a held pane the operator deliberately kept. Only
 * the LAST pane honours Esc; the rest call `preventDefault`, which unwinds the
 * assembly one pane at a time from the outside in.
 *
 * ## An outside click closes ALL of them
 *
 * The opposite of Esc, deliberately (mt#4143, operator decision ask#8509).
 * Clicking away from the peek means "give me the page back", which is the
 * drawer idiom Notion's side peek set; Esc remains the way to unwind one pane
 * at a time when a held pair is what you want to take apart. "Away from the
 * peek" means away from EVERY pane and from every entity ref — `peek-dismiss.ts`
 * owns that verdict, and its docblock records why the per-pane reading would
 * have destroyed the held pair.
 *
 * ## One divider sizes the whole assembly
 *
 * The panes share ONE width, set by a single `PaneDivider` at the seam against
 * the page (mt#4261). Per-pane widths were considered and left out: they need a
 * divider between every pair and a width per pane, to serve a case — a narrow
 * held reference beside a wide live pane — nobody has asked for. `peek-width.ts`
 * owns the policy, including why the ceiling is a share of the viewport for the
 * ASSEMBLY rather than for each pane.
 */
import { PanelRightClose, Pin, SquareArrowOutUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { usePeek, restorePeekOpenerFocus } from "../lib/peek";
import {
  PEEK_PANE_ATTR,
  PEEK_ASSEMBLY_ATTR,
  FOCUS_OUTSIDE_EVENT_TYPE,
  shouldDismissPeek,
  outsideEventTarget,
} from "../lib/peek-dismiss";
import { usePeekWidth } from "../lib/peek-width";
import { entityToPath, type RoutableEntityType } from "../lib/entity-codec";
import { useResolvedEntityLabel } from "../lib/use-entity-index";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetTitle,
  SheetCloseButton,
} from "./ui/sheet";
import { PeekBody } from "./PeekBody";
import { PaneDivider } from "./PaneDivider";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * CSS custom property carrying the pane width (mt#4274).
 *
 * Set from React state on every render, and overwritten IMPERATIVELY during a
 * drag so the pointer can be tracked without re-rendering the assembly. The two
 * writers cannot disagree for long: a drag ends in a commit, which changes the
 * state React renders from, which re-applies the property from the value that
 * was just committed.
 *
 * ## The measured trade, stated so it is not rediscovered as a regression
 *
 * A custom property is INHERITED, so writing it invalidates style for every
 * descendant that could read it. Measured per pointermove at 1440x900 with a
 * task-detail body open, before → after:
 *
 *   script  11.82ms → 0.45ms      (the point of the change)
 *   layout   1.22ms → 1.35ms      (unchanged; the pane still resizes)
 *   recalc   0.30ms → 1.95ms      (the cost of this indirection)
 *   total   13.34ms → 3.75ms
 *
 * Taken deliberately: recalc scales with the pane's descendant count, so a much
 * larger body would push it up, but the total sits at ~22% of a 16.7ms frame
 * and the blocking half — script — is 26x cheaper.
 *
 * The obvious alternative, writing `style.width` on each pane node directly,
 * avoids the inherited-property invalidation and reintroduces the problem this
 * indirection solves: React would then own `width` as a rendered prop AND the
 * drag would overwrite it, and React diffs against its own previous value
 * rather than the DOM, so a commit landing on the pre-drag number would leave
 * the imperative value in place. The custom property is what lets both writers
 * target the same declaration without fighting.
 */
const PEEK_WIDTH_VAR = "--peek-pane-width";

/**
 * DOM id for a pane, so the divider's `aria-controls` can name what it sizes.
 *
 * Keyed on POSITION rather than on the entity, deliberately: an entity id can
 * carry characters an id selector has to escape (`mt#4261`), the assembly is
 * small and ordered, and `aria-controls` only has to resolve within the document
 * as it currently stands.
 */
function peekPaneDomId(index: number): string {
  return `peek-pane-${index}`;
}

/**
 * Pane title — the resolved entity label, not the raw id.
 *
 * Found by looking at it (mt#3694 live verification): a memory pane titled
 * `fbcb360f-fe0e-402d-9b35-7e3c2b2ab59a` is unreadable, and `cockpit-deeplinks`
 * already makes the general rule — show a short readable ref, keep the full id
 * in the target. Uses the SAME resolver `EntityRef` uses, so a pane and the link
 * that opened it never disagree about what the entity is called.
 *
 * Degrades to the bare id when nothing resolves, which is the pre-existing
 * behavior and is correct for a task id like `mt#4010` that is already readable.
 * Its own component because a hook cannot be called inside the pane map.
 */
function PaneTitle({ type, id }: { type: RoutableEntityType; id: string }) {
  const info = useResolvedEntityLabel(type, id);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
  // A raw uuid is never the best available title: prefer the label, and fall
  // back to a truncated prefix rather than 36 characters of hex.
  const fallback = isUuid ? `${id.slice(0, 8)}…` : id;
  return (
    <SheetTitle title={id}>
      {info?.label ? (
        <>
          <span className="text-muted-foreground">{fallback}</span>
          <span className="ml-2 font-sans font-normal">{info.label}</span>
        </>
      ) : (
        fallback
      )}
    </SheetTitle>
  );
}

export function PeekHost() {
  const { panes, closePeek, holdPeek, closeAllPeeks } = usePeek();
  // Before the early return below — a hook cannot be called conditionally, and
  // this one has to see every render to keep tracking the viewport.
  const { widthPx, minPx, maxPx, setWidth, resetWidth, previewWidth } = usePeekWidth(panes.length);

  /**
   * The assembly container, so a drag can repaint without a render (mt#4274).
   *
   * Routing every `pointermove` through `setWidth` re-rendered each pane's whole
   * detail body — 498 of a pane's 518 elements — at a measured 11.82ms of
   * scripting per move against a 16.7ms frame budget. Writing the width to a CSS
   * custom property on this node instead does the same visual work with zero
   * React reconciliation; `onCommit` then records the settled value once.
   */
  const hostRef = useRef<HTMLDivElement | null>(null);

  const paintWidth = useCallback(
    (requestedPx: number) => {
      hostRef.current?.style.setProperty(PEEK_WIDTH_VAR, `${previewWidth(requestedPx)}px`);
    },
    [previewWidth]
  );

  const commitWidth = useCallback(
    (requestedPx: number) => {
      setWidth(requestedPx);
      // Repaint from the committed value too. React re-renders on the state
      // change and re-applies the property — but it diffs against its OWN
      // previous value, not against the DOM, so a drag that lands back on the
      // starting width would leave the imperative value in place unnoticed.
      paintWidth(requestedPx);
    },
    [setWidth, paintWidth]
  );

  const commitReset = useCallback(() => {
    resetWidth();
    // Same reason as above, and this path needs it more: `resetWidth` clears the
    // preference rather than setting a number, so there is no new value for
    // React to diff against — without this the pane would keep the dragged
    // width until something else re-rendered it.
    hostRef.current?.style.removeProperty(PEEK_WIDTH_VAR);
  }, [resetWidth]);

  // Return focus to the link that opened the peek once the assembly empties
  // (mt#3694 R2). Keyed on the TRANSITION to zero panes rather than on any one
  // close handler, because the assembly can empty three different ways — Esc,
  // the close button, and browser Back — and only this condition is common to
  // all three. Back in particular reaches no Radix close handler at all: it
  // rewrites the URL, and the panes simply stop being derived.
  const hadPanes = useRef(false);
  useEffect(() => {
    if (panes.length === 0 && hadPanes.current) restorePeekOpenerFocus();
    hadPanes.current = panes.length > 0;
  }, [panes.length]);

  if (panes.length === 0) return null;

  return (
    <div
      ref={hostRef}
      className="pointer-events-none fixed inset-y-0 right-0 z-40 flex"
      // The width every pane reads. Rendered from state so a reload, a viewport
      // change or a reset lands correctly; overwritten imperatively mid-drag.
      style={{ [PEEK_WIDTH_VAR]: `${widthPx}px` } as CSSProperties}
      data-testid="peek-host"
      // Behavioral, not a test hook: this is the assembly region `peek-dismiss.ts`
      // exempts, which is what keeps the divider below from dismissing the peek
      // on the first pointerdown of every drag.
      {...{ [PEEK_ASSEMBLY_ATTR]: "true" }}
    >
      {/*
       * The resize handle, at the seam against the page (mt#4261). One divider
       * for the assembly rather than one per pane: the width is shared, so a
       * second handle would offer a control that does not exist.
       */}
      <PaneDivider
        value={widthPx}
        min={minPx}
        max={maxPx}
        resizes="right"
        controls={panes.map((_, index) => peekPaneDomId(index)).join(" ")}
        onChange={paintWidth}
        onCommit={commitWidth}
        onReset={commitReset}
        label="Resize the peek"
        className="pointer-events-auto"
        data-testid="peek-divider"
      />
      {panes.map((pane, index) => {
        const isLast = index === panes.length - 1;
        return (
          <Sheet
            key={`${pane.type}:${pane.id}`}
            open
            onOpenChange={(next) => {
              if (!next) closePeek(index);
            }}
          >
            <SheetContent
              // Width is the OPERATOR's (mt#4261), defaulting to what mt#4123
              // made responsive. `lib/peek-width.ts` owns the policy; the two
              // pieces of history worth keeping at the render site:
              //
              // mt#3694's `w-[26rem] max-w-[92vw]` was effectively a constant —
              // 92vw only binds below ~452px, so at every width an operator
              // actually uses the pane was 416px regardless of what it covered.
              // At 1440 that is 29% and fine; at the ~620px window the principal
              // reported from it is 67%, with the page behind sliced mid-word,
              // which defeats the one thing a peek is for.
              //
              // mt#4123 answered that with `min(26rem,45vw)` — still the DEFAULT
              // here, now computed in JS rather than CSS because the divider
              // needs a number to report and to drag from. A breakpoint flipping
              // the pane to full-width was the alternative then; it hides the
              // page entirely, which is a different failure rather than a fix.
              className="pointer-events-auto shrink-0"
              // Sized from the custom property, not from `widthPx` directly
              // (mt#4274). That indirection is the whole fix: a drag repaints by
              // writing the property on the host, which resizes every pane
              // through CSS with no React render at all. The fallback keeps the
              // pane correct if the property is ever absent.
              style={{ width: `var(${PEEK_WIDTH_VAR}, ${widthPx}px)` }}
              // `shrink-0` above is as load-bearing as the width: without it the
              // flex row would squeeze panes below what the operator dragged as
              // soon as the assembly approached the viewport's edge, silently
              // undoing the clamp rather than letting it bind.
              id={peekPaneDomId(index)}
              data-testid="peek-pane"
              // Behavioral, not a test hook: `peek-dismiss.ts` resolves "is this
              // click inside SOME pane?" by walking up to this attribute.
              {...{ [PEEK_PANE_ATTR]: "true" }}
              data-peek-type={pane.type}
              data-peek-id={pane.id}
              data-peek-held={pane.held ? "true" : "false"}
              onEscapeKeyDown={(event) => {
                // See the module doc: one pane per Esc, outermost held panes last.
                if (!isLast) event.preventDefault();
              }}
              // An outside click dismisses the WHOLE assembly, except on a peek
              // pane or an entity ref (mt#4143, operator decision ask#8509).
              // `peek-dismiss.ts` owns the verdict and the reasoning; two things
              // are decided here because they are about this component:
              //
              // 1. `onInteractOutside` is the only handler wired, because it is
              //    the only one that fires on BOTH the pointer and focus paths.
              //    The two path-specific handlers this replaced were redundant
              //    with it — measured, not assumed (mt#4143).
              // 2. The FOCUS path stays unconditionally suppressed, preserving
              //    the pre-mt#4143 behavior. ask#8509 decided what a CLICK does;
              //    tabbing through the page behind a pane is not a dismissal
              //    gesture, and treating it as one would make the peek unusable
              //    with a keyboard.
              //
              // Dismissal calls `closeAllPeeks` from the LAST pane only, and
              // every pane still calls `preventDefault`, so Radix never drives
              // the close itself. Both halves matter: N panes each firing their
              // own index-based `closePeek` in one tick would remove index 0 and
              // then index 1 of an already-shifted array. The same one-pane-owns-it
              // shape as the Esc handler above.
              onInteractOutside={(event) => {
                event.preventDefault();
                if (event.type === FOCUS_OUTSIDE_EVENT_TYPE) return;
                if (!isLast) return;
                if (shouldDismissPeek(outsideEventTarget(event))) closeAllPeeks();
              }}
            >
              <SheetHeader>
                <PaneTitle type={pane.type} id={pane.id} />
                <div className="ml-auto flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={pane.held ? "Pane held" : "Hold this pane"}
                    aria-pressed={pane.held}
                    title={
                      pane.held
                        ? "Held — the next entity you open will appear beside this one"
                        : "Hold this pane so the next entity opens beside it"
                    }
                    onClick={() => holdPeek(index)}
                    className={
                      pane.held
                        ? "rounded-sm p-1 text-primary"
                        : "rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
                    }
                  >
                    <Pin className="h-4 w-4" />
                  </button>
                  <Link
                    to={entityToPath(pane.type, pane.id)}
                    aria-label={`Open ${pane.id} as a page`}
                    title="Open as page"
                    className="rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <SquareArrowOutUpRight className="h-4 w-4" />
                  </Link>
                  <SheetCloseButton aria-label={`Close ${pane.id}`} />
                </div>
              </SheetHeader>
              <SheetBody>
                {/*
                 * Bounded per pane (mt#4069). Every route in `App.tsx` gets a
                 * boundary; the peek did not, and it renders over whatever page
                 * the operator is already on — so a body that throws took the
                 * HOST page down with it and left a blank overlay behind. A
                 * blank pane is the precise failure this task exists to remove,
                 * so the pane names its own crash instead of propagating.
                 */}
                <ErrorBoundary id={`peek-${pane.type}`}>
                  <PeekBody type={pane.type} id={pane.id} />
                </ErrorBoundary>
              </SheetBody>
            </SheetContent>
          </Sheet>
        );
      })}
    </div>
  );
}

/** Icon re-exported for the rail/empty-state affordances that reference it. */
export { PanelRightClose };
