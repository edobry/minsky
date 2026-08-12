/**
 * usePeek — the side peek's controller (mt#3694).
 *
 * ## The URL is the state
 *
 * There is no provider and no React state here: panes are DERIVED from the
 * `?peek=` query parameter on every render, and every mutation is a
 * `setSearchParams` call. That is not a stylistic choice — three of the task's
 * success criteria collapse into it:
 *
 *   - **URL-addressable.** True by construction; there is no second copy of
 *     the state that could disagree with the link you copied.
 *   - **Browser Back closes the peek.** Each mutation pushes one history entry,
 *     so Back pops it. No history bookkeeping of our own.
 *   - **The assembly is ephemeral and dies with the origin page.** Navigating
 *     to another route produces a URL with no `peek` param, so the panes are
 *     gone — no teardown effect to forget, and nothing is persisted anywhere.
 *
 * The one thing this deliberately does NOT do is touch the pathname. A peek is
 * the path that does NOT navigate: leaving the pathname alone is what keeps the
 * underlying page mounted with its scroll position and fetched data, and what
 * keeps `TabsProvider`'s open-on-visit effect (`tabs.tsx`) from firing — that
 * effect keys on `matchEntityRoute(pathname)`, so a search-only change cannot
 * reach it. That is why a peek cannot be implemented as a route change.
 *
 * The pane-list algebra itself lives in `peek-codec.ts`, kept pure so the
 * interaction model is testable without a router.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { RoutableEntityType } from "./entity-codec";
import {
  PEEK_PARAM,
  decodePeekPanes,
  encodePeekPanes,
  openPane,
  holdPane,
  closePane,
  type PeekPane,
} from "./peek-codec";

export interface PeekTarget {
  type: RoutableEntityType;
  id: string;
}

export interface PeekController {
  /** Open panes, outermost first. Empty when no peek is open. */
  panes: PeekPane[];
  /**
   * Ordinary open: REPLACES the last pane unless it is held, in which case the
   * new pane lands beside it.
   */
  openPeek: (target: PeekTarget) => void;
  /**
   * Open and immediately hold the pane that was already there — the shift-click
   * gesture. Holding the CURRENT pane is what makes the new one land beside it
   * rather than on top of it.
   */
  openPeekHolding: (target: PeekTarget) => void;
  /** Hold the pane at `index` so the next ordinary open lands beside it. */
  holdPeek: (index: number) => void;
  /** Close one pane (default: the last). */
  closePeek: (index?: number) => void;
  /** Close every pane, removing the parameter entirely. */
  closeAllPeeks: () => void;
}

export function usePeek(): PeekController {
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = searchParams.get(PEEK_PARAM);
  const panes = useMemo(() => decodePeekPanes(raw), [raw]);

  const commit = useCallback(
    (next: PeekPane[]) => {
      setSearchParams(
        (current) => {
          // Rebuild from the CURRENT params rather than a captured copy: the
          // underlying page owns its own query state (filters, tabs, a
          // conversation's turn address) and a peek must not clobber it.
          const params = new URLSearchParams(current);
          const encoded = encodePeekPanes(next);
          if (encoded === null) params.delete(PEEK_PARAM);
          else params.set(PEEK_PARAM, encoded);
          return params;
        },
        // A push (not a replace) is what makes Back close the peek.
        { replace: false }
      );
    },
    [setSearchParams]
  );

  const openPeek = useCallback(
    (target: PeekTarget) => commit(openPane(panes, target)),
    [commit, panes]
  );

  const openPeekHolding = useCallback(
    (target: PeekTarget) => {
      // Hold what is on screen, THEN open — so the existing pane survives and
      // the new one appends. With nothing open yet this is an ordinary open.
      const held = panes.length > 0 ? holdPane(panes, panes.length - 1) : panes;
      commit(openPane(held, target));
    },
    [commit, panes]
  );

  const holdPeek = useCallback((index: number) => commit(holdPane(panes, index)), [commit, panes]);

  const closePeek = useCallback(
    (index?: number) => commit(closePane(panes, index)),
    [commit, panes]
  );

  const closeAllPeeks = useCallback(() => commit([]), [commit]);

  return { panes, openPeek, openPeekHolding, holdPeek, closePeek, closeAllPeeks };
}

/**
 * Should this click open a peek, or fall through to ordinary navigation?
 *
 * Cmd/Ctrl-click, middle-click, and shift-less modified clicks are the
 * operator asking for a real navigation (a new tab, a new window, the promote
 * gesture) — those must reach the browser untouched. Shift-click is claimed as
 * the HOLD gesture, which is the one place this diverges from a plain link.
 *
 * Exported for direct testing: the branch matters more than it looks, because
 * getting it wrong silently disables "open in new tab" on every entity
 * reference in the cockpit.
 */
export function classifyRefClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): "navigate" | "peek" | "peek-holding" {
  // Anything but a primary click is the browser's (middle-click = new tab).
  if (event.button !== 0) return "navigate";
  // The promote gesture: Cmd/Ctrl-click opens the entity as a full page.
  if (event.metaKey || event.ctrlKey) return "navigate";
  // Alt-click is download/save in several browsers — do not claim it.
  if (event.altKey) return "navigate";
  if (event.shiftKey) return "peek-holding";
  return "peek";
}
