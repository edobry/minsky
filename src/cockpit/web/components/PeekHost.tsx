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
 */
import { PanelRightClose, Pin, SquareArrowOutUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useEffect, useRef } from "react";
import { usePeek, restorePeekOpenerFocus } from "../lib/peek";
import {
  PEEK_PANE_ATTR,
  FOCUS_OUTSIDE_EVENT_TYPE,
  shouldDismissPeek,
  outsideEventTarget,
} from "../lib/peek-dismiss";
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
import { ErrorBoundary } from "./ErrorBoundary";

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
    <div className="pointer-events-none fixed inset-y-0 right-0 z-40 flex" data-testid="peek-host">
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
              // Width is RESPONSIVE, not fixed (mt#4123). `w-[26rem]
              // max-w-[92vw]` was effectively a constant: 92vw only binds below
              // ~452px, so at every width an operator actually uses, the pane was
              // 416px regardless of what it was covering. At 1440 that is 29% and
              // fine; at the ~620px window the principal reported from, it is 67%
              // and the page behind is sliced mid-word — which defeats the one
              // thing a peek is for, keeping your place readable.
              //
              // `min(26rem,45vw)` keeps 416px wherever there is room for it (any
              // viewport ≥ ~924px, so the wide case is unchanged, including two
              // held panes: 832 of 1440 still leaves 608px of page) and yields to
              // a proportion below that, so the page keeps a majority column at
              // EVERY width. A breakpoint that flips the pane to full-width was
              // the alternative; it hides the page entirely, which is a different
              // failure rather than a fix, and it makes the pane's size jump
              // during a window drag.
              className="pointer-events-auto w-[min(26rem,45vw)]"
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
