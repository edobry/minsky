/**
 * NotFoundPage — the surface for a URL that matches no route (mt#3470).
 *
 * Before this, an unmatched path rendered the full shell (rail, header, tab
 * strip) around a literally empty `<main>` — `main.innerHTML.length === 0`,
 * measured against the running cockpit. That is indistinguishable from a
 * broken feature. This page names the path that failed to resolve, so a wrong
 * address reads as a wrong address, and offers one route onward.
 *
 * Deliberately NOT a redirect to `/`: silently bouncing an unknown URL hides
 * the mistake and the operator never learns which link is dead. That is what
 * lets a retired route be deleted outright instead of carrying a redirect
 * forever (the `/context`, `/conversations`, `/plant-grid` pattern in App.tsx).
 *
 * Not built on `ErrorState`: that primitive is `text-destructive` with
 * `role="alert"`, and `docs/design-system.md` §5.1 reserves red for hard-alarm
 * states that call for action now. A wrong URL is a navigation miss, not an
 * alarm.
 *
 * Client-side only: `src/cockpit/server.ts`'s SPA fallback serves index.html
 * with HTTP 200 for every unmatched GET, so the response status stays 200 no
 * matter what renders here. Returning a real 404 would require the server to
 * know the client route table.
 */
import { Link, useLocation } from "react-router-dom";

export function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <div className="p-4 max-w-5xl mx-auto w-full space-y-3" data-testid="not-found-page">
      <h1 className="text-h1 font-semibold text-foreground">No such page</h1>
      <p className="text-sm text-muted-foreground">
        {/* Chip styling matches the inline-code idiom in components/Prose.tsx. */}
        <code
          className="rounded bg-muted/50 px-1 py-0.5 font-mono text-[0.85em] text-foreground"
          data-testid="not-found-path"
        >
          {pathname}
        </code>{" "}
        does not match any route. It may be a typo, or a route that has since been retired.
      </p>
      <Link
        to="/"
        className="inline-block text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        Home →
      </Link>
    </div>
  );
}
