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
 */
import { PanelRightClose, Pin, SquareArrowOutUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useEffect, useRef } from "react";
import { usePeek, restorePeekOpenerFocus } from "../lib/peek";
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
  const { panes, closePeek, holdPeek } = usePeek();

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
              className="pointer-events-auto w-[26rem] max-w-[92vw]"
              data-testid="peek-pane"
              data-peek-type={pane.type}
              data-peek-id={pane.id}
              data-peek-held={pane.held ? "true" : "false"}
              onEscapeKeyDown={(event) => {
                // See the module doc: one pane per Esc, outermost held panes last.
                if (!isLast) event.preventDefault();
              }}
              // A peek must NOT dismiss when the operator touches the page
              // behind it — coexisting with a live page is the entire feature,
              // and Radix's default is to treat any outside interaction as a
              // dismissal. Left at its default this silently breaks the hold
              // gesture: shift-clicking a ref lands OUTSIDE the open pane, so
              // the pane closes at the same moment the hold opens the next one,
              // and two panes collapse back to one. Found by the integration
              // test in PeekHost.test.tsx — every unit along the path
              // (the click classifier, the pane algebra, the URL round-trip)
              // passed in isolation while the composed behavior was wrong.
              // Closing is Esc, the close button, Back, or being replaced.
              onPointerDownOutside={(event) => event.preventDefault()}
              onInteractOutside={(event) => event.preventDefault()}
              onFocusOutside={(event) => event.preventDefault()}
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
                <PeekBody type={pane.type} id={pane.id} />
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
