import * as React from "react";
import { Link } from "react-router-dom";

import { cn } from "../../lib/utils";

/**
 * LinkCard — a Card whose entire surface navigates to `to`.
 *
 * Used for home-page System-status cards that summarize a subsystem and have a
 * dedicated page route (Credentials, Embeddings). The whole card is a
 * single navigation target, so it MUST NOT contain other interactive elements
 * (buttons, links, selects) — nesting them inside an anchor is invalid HTML and
 * would hijack their clicks. Cards with interactive children (e.g. Attention)
 * keep a header-only link instead.
 *
 * Base surface mirrors `Card` (card.tsx); the hover/focus affordance mirrors the
 * nav-tile `EntryTile` pattern (retired with the home nav tiles in mt#2398;
 * the persistent rail is the navigation surface now) so the two tiers read as
 * the same interaction vocabulary. The `group` class lets child elements (e.g. a
 * header chevron) brighten on card hover.
 */
const LinkCard = React.forwardRef<
  HTMLAnchorElement,
  { to: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>
>(({ to, className, children, ...props }, ref) => (
  <Link
    ref={ref}
    to={to}
    className={cn(
      "group block rounded-lg border border-border bg-card text-card-foreground shadow-sm",
      "transition-colors hover:bg-card/80 hover:border-border/80",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      className
    )}
    {...props}
  >
    {children}
  </Link>
));
LinkCard.displayName = "LinkCard";

export { LinkCard };
