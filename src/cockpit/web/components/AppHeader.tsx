/**
 * AppHeader — sticky top bar for Minsky Cockpit.
 *
 * Slots:
 *   Left:   menu/sandwich icon (opens NavSheet) + "Minsky Cockpit" wordmark
 *   Center: reserved (future: workspace/session switcher)
 *   Right:  settings icon (no-op/disabled) + user avatar stub (inert)
 *
 * Height: h-14 (56px). Position: sticky top-0 z-40.
 * Border: border-b border-border for subtle elevation separation.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Menu, Settings, User } from "lucide-react";
import { Button } from "./ui/button";
import { NavSheet } from "./NavSheet";
import { cn } from "../lib/utils";

interface AppHeaderProps {
  className?: string;
}

export function AppHeader({ className }: AppHeaderProps) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <>
      <header
        className={cn(
          "sticky top-0 z-40 h-14 w-full",
          "flex items-center gap-2 px-3",
          "bg-background border-b border-border",
          className
        )}
      >
        {/* Left slot: menu + wordmark */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation menu"
            className="h-8 w-8"
          >
            <Menu aria-hidden="true" className="h-4 w-4" />
          </Button>

          <Link
            to="/"
            className="flex items-center gap-1 hover:opacity-80 transition-opacity"
            aria-label="Minsky Cockpit home"
          >
            <span className="font-mono text-sm font-semibold text-primary">Minsky</span>
            <span className="text-sm font-medium text-muted-foreground">Cockpit</span>
          </Link>
        </div>

        {/* Center slot: reserved for future workspace/session switcher */}
        <div className="flex-1" />

        {/* Right slot: settings + user */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings (not yet implemented)"
            className="h-8 w-8 opacity-50 cursor-not-allowed"
            tabIndex={-1}
            onClick={(e) => e.preventDefault()}
          >
            <Settings aria-hidden="true" className="h-4 w-4" />
          </Button>

          {/* User avatar stub — inert placeholder circle */}
          <div
            className={cn(
              "h-7 w-7 rounded-full",
              "bg-muted flex items-center justify-center flex-shrink-0",
              "ring-1 ring-border"
            )}
            aria-label="User (not yet connected)"
            role="img"
          >
            <User aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
        </div>
      </header>

      {/* NavSheet renders outside the header so it overlays the full viewport */}
      <NavSheet open={navOpen} onOpenChange={setNavOpen} />
    </>
  );
}
