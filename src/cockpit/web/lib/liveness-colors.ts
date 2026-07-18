/**
 * Shared liveness-dot color mapping (mt#2909).
 *
 * Extracted from `widgets/Agents.tsx` so both `Agents.tsx` and
 * `widgets/RunDetail.tsx` can import the SAME implementation without
 * creating a module cycle: `Agents.tsx` already imports `basePathFor` /
 * `pathForTab` from `RunDetail.tsx` (the workspace-detail tab-routing
 * helpers), so `RunDetail.tsx` importing `livenessDotClass` back from
 * `Agents.tsx` would have closed a circular-import loop (PR #2040 review
 * finding). Living here, neither widget imports from the other.
 */

export type Liveness = "healthy" | "idle" | "stale" | "orphaned" | null;

/** Maps a session's liveness state to its `bg-liveness-*` Tailwind token (tailwind.config.ts). */
export function livenessDotClass(liveness: Liveness): string {
  switch (liveness) {
    case "healthy":
      return "bg-liveness-healthy";
    case "idle":
      return "bg-liveness-idle";
    case "stale":
      return "bg-liveness-stale";
    case "orphaned":
      return "bg-liveness-orphaned";
    case null:
      return "";
  }
}
