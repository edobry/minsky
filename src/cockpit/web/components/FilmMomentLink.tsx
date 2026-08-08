/**
 * "Watch this moment" — the affordance that takes a reader from a transcript
 * row to the film's playhead on that same action (mt#3794).
 *
 * The exact inverse of the film ribbon's "open in conversation view" link
 * (mt#3791), and deliberately built on the SAME address: `turnAddressSearch`
 * encodes `?turn=N&toolUse=ID`, which the film resolves to a batch row after
 * its fold (`findRowForTurnAddress`). One address grammar, both directions —
 * a second, film-specific parameter would have to be kept in sync with this one
 * forever for no gain.
 *
 * ## Why the path comes from a prop
 *
 * `ConversationView` is rendered by several callers, some with no router at all
 * — which is why mt#3791 passes the INBOUND address down as a prop rather than
 * reading the URL. The outbound direction has the same constraint plus one
 * more: the film's path depends on the keyspace, and a workspace has no film to
 * link to (mt#3468 — a film replays a CONVERSATION, and reaching one through a
 * workspace would mean "the film of whichever conversation is selected," which
 * names no specific thing). So the router-aware caller supplies `filmPathFor`,
 * and a surface with no film simply supplies nothing and renders no affordance.
 *
 * ## Why hover-reveal, and why that is not the whole story
 *
 * A transcript is dense and mostly read, not acted on; a per-row control shown
 * at all times would be chrome on every row of a thousand-row thread. But
 * hover-only would put the affordance out of reach of a keyboard entirely, so
 * `focus-visible:opacity-100` is not decoration here — it is the second half of
 * the mechanism. The link is always in the tab order and always announces; only
 * its VISIBILITY is hover-bound. Per `src/cockpit/CLAUDE.md`
 * §Accessibility-first primitives.
 *
 * The reveal-on-hover class itself is the CALLER's, passed as a literal through
 * `className`. Tailwind generates classes by scanning source text, so a
 * `group-hover/${name}` built at runtime here would name a class that was never
 * generated — the group variant has to appear literally in the file that knows
 * which group it belongs to.
 */
import { Link } from "react-router-dom";
import { Clapperboard } from "lucide-react";
import { cn } from "../lib/utils";
import { turnAddressSearch, type TurnAddress } from "../lib/conversation-turn-address";

export interface FilmMomentLinkProps {
  /** The moment to land on — this row's own transcript position. */
  address: TurnAddress;
  /**
   * Path of the film tab this conversation is shown in, WITHOUT a query string.
   * Supplied by the router-aware caller; see the module note above.
   */
  filmPath: string;
  /**
   * Reveal variant, e.g. `"group-hover/call:opacity-100"`. Must be a literal in
   * the caller's source for Tailwind to generate it.
   */
  className?: string;
}

export function FilmMomentLink({ address, filmPath, className }: FilmMomentLinkProps) {
  return (
    <Link
      to={`${filmPath}${turnAddressSearch(address)}`}
      aria-label="Watch this moment in the film"
      title="Watch this moment in the film"
      data-testid="film-moment-link"
      className={cn(
        "shrink-0 rounded p-1 text-muted-foreground/70 opacity-0 transition-opacity",
        "hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <Clapperboard aria-hidden className="h-3.5 w-3.5" />
    </Link>
  );
}
