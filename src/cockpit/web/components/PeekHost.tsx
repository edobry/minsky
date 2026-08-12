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
import { usePeek } from "../lib/peek";
import { entityToPath } from "../lib/entity-codec";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetTitle,
  SheetCloseButton,
} from "./ui/sheet";
import { PeekBody } from "./PeekBody";

export function PeekHost() {
  const { panes, closePeek, holdPeek } = usePeek();

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
                <SheetTitle>{pane.id}</SheetTitle>
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
