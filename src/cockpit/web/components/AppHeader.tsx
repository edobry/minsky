/**
 * AppHeader — sticky top bar for Minsky Cockpit.
 *
 * Slots:
 *   Left:   menu/sandwich icon (opens NavSheet) + "Minsky Cockpit" wordmark
 *   Center: reserved (future: workspace/session switcher)
 *   Right:  settings icon (links to /settings) + user avatar stub (inert)
 *
 * Height: h-14 (56px). Position: sticky top-0 z-40.
 * Border: border-b border-border for subtle elevation separation.
 */
import { useState, useEffect } from "react";
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
  const [commit, setCommit] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: Record<string, unknown>) => {
        if (typeof data.commit === "string" && data.commit !== "unknown") {
          setCommit(data.commit as string);
        }
      })
      .catch(() => {});
  }, []);

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
            {commit && (
              <span className="font-mono text-[10px] text-muted-foreground/50 ml-1">{commit}</span>
            )}
          </Link>
        </div>

        {/* Center slot: reserved for future workspace/session switcher */}
        <div className="flex-1" />

        {/* Right slot: settings + user */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <Link
            to="/settings"
            aria-label="Settings"
            className={cn(
              "inline-flex items-center justify-center h-8 w-8 rounded-md",
              "text-muted-foreground hover:text-foreground hover:bg-accent",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            <Settings aria-hidden="true" className="h-4 w-4" />
          </Link>

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