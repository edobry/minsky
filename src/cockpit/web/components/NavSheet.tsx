/**
 * NavSheet — slide-in navigation panel for Minsky Cockpit.
 *
 * Triggered by the sandwich icon in AppHeader. Lists the primary routes:
 *   / (Home), /agents, /context, /workstreams, /tasks, /asks, /activity
 *
 * Uses a hand-rolled drawer panel backed by a dialog-accessible overlay rather
 * than pulling in the full shadcn Sheet component (which needs additional
 * Radix primitives). The route list is intentionally minimal — nav depth
 * doesn't justify a full sidebar yet.
 *
 * Closes on: link click, backdrop click, Escape key.
 */
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Bot,
  FileSearch,
  GitBranch,
  List,
  Network,
  MessageCircleQuestion,
  Bell,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

interface NavSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface NavItem {
  to: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: "/",
    label: "Home",
    description: "Dashboard overview",
    icon: LayoutDashboard,
  },
  {
    to: "/agents",
    label: "Agents",
    description: "Sessions in flight",
    icon: Bot,
  },
  {
    to: "/context",
    label: "Context",
    description: "Session context inspector",
    icon: FileSearch,
  },
  {
    to: "/workstreams",
    label: "Work Streams",
    description: "Active task workstreams",
    icon: GitBranch,
  },
  {
    to: "/tasks",
    label: "Tasks",
    description: "List and graph views",
    icon: Network,
    exact: true,
  },
  {
    to: "/tasks/list",
    label: "Task List",
    description: "Flat sortable task table",
    icon: List,
  },
  {
    to: "/asks",
    label: "Asks",
    description: "Pending principal-attention asks",
    icon: MessageCircleQuestion,
  },
  {
    to: "/activity",
    label: "Activity",
    description: "System event log",
    icon: Bell,
  },
];

export function NavSheet({ open, onOpenChange }: NavSheetProps) {
  const location = useLocation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the close button when the sheet opens
  useEffect(() => {
    if (open) {
      // Small timeout to allow the CSS transition to start
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        className={cn(
          "fixed left-0 top-0 z-50 h-full w-64",
          "bg-background border-r border-border",
          "flex flex-col"
        )}
      >
        {/* Sheet header */}
        <div className="flex items-center justify-between h-14 px-4 border-b border-border flex-shrink-0">
          <span className="text-sm font-semibold">
            <span className="font-mono text-primary">Minsky</span>
            <span className="text-muted-foreground"> Cockpit</span>
          </span>
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            aria-label="Close navigation menu"
            className="h-8 w-8"
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto py-2" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.to === "/" || item.exact
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to);
            const Icon = item.icon;

            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => onOpenChange(false)}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 text-sm transition-colors",
                  "hover:bg-muted/60",
                  isActive ? "bg-muted text-foreground font-medium" : "text-muted-foreground"
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon aria-hidden className="h-4 w-4 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium leading-none">{item.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">
                    {item.description}
                  </div>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex-shrink-0">
          <p className="text-xs text-muted-foreground">Minsky Cockpit v0 — local only</p>
        </div>
      </div>
    </>
  );
}