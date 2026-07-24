/**
 * usePrefersReducedMotion — JS-level `prefers-reduced-motion` signal (mt#3184
 * — Watchable world Phase 1, spec SC 6 / AT 7).
 *
 * The plant board's motion tokens (`animate-status-dot`, `animate-hook-denial`
 * in index.css) gate purely via CSS media queries, which is sufficient for
 * decorative CSS animations. The session-film stage needs a JS-level branch
 * too: under reduced motion, an avatar excursion must render as a DISCRETE
 * state change (no tween element/class at all — spec AT 7: "renders discrete
 * state changes (no tween classes present)"), not merely a CSS animation
 * with its duration zeroed out.
 */
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function readPreference(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readPreference);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(QUERY);
    const handler = () => setReduced(mql.matches);
    handler();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return reduced;
}
