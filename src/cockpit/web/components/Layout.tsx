/**
 * Layout — shell wrapper for the Cockpit app (mt#2397).
 *
 * Two-column app shell:
 *   1. Rail — persistent left navigation spine (replaces the retired hamburger
 *      → NavSheet slide-in). Always visible; the primary nav surface.
 *   2. Main content area (scrollable, full-height beside the rail).
 *
 * The global CommandPalette (⌘K) is mounted here so it is available from every
 * route. Children render inside <main> as-is; individual pages control their
 * own internal layout. This keeps Layout thin and the rail composable — a
 * future view can supply a different spine without touching the routed content
 * (Layout-flexibility mandate, mt#2370).
 */
import { type ReactNode } from "react";
import { Rail } from "./Rail";
import { CommandPalette } from "./CommandPalette";

interface Props {
  children: ReactNode;
}

export function Layout({ children }: Props) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Rail />
      <main className="flex-1 overflow-auto min-w-0">{children}</main>
      <CommandPalette />
    </div>
  );
}
