/**
 * Layout — shell wrapper for the Cockpit app.
 *
 * Renders:
 *   1. AppHeader (sticky top bar — nav, wordmark, settings, user)
 *   2. Main content area (scrollable, full-height below header)
 *
 * Children are rendered inside <main> as-is. Individual pages control their
 * own internal layout (grid, flex, max-width, padding). This keeps Layout thin
 * and avoids forcing all pages into the same grid.
 */
import { type ReactNode } from "react";
import { AppHeader } from "./AppHeader";
import { CommandPalette } from "./CommandPalette";

interface Props {
  children: ReactNode;
}

export function Layout({ children }: Props) {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
      <CommandPalette />
    </div>
  );
}
