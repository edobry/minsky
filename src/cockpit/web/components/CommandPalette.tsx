import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "./ui/command";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { getRecentItems, addRecentItem, type RecentItem } from "../lib/recent-items";

// ---------------------------------------------------------------------------
// Entity types for the palette
// ---------------------------------------------------------------------------

interface PaletteTask {
  type: "task";
  id: string;
  title: string;
  status: string;
}

interface PaletteSession {
  type: "session";
  id: string;
  taskId: string | null;
  taskTitle: string | null;
  liveness: string;
}

interface PaletteAsk {
  type: "ask";
  id: string;
  title: string;
  kind: string;
  parentTaskId: string | null;
}

interface PalettePage {
  type: "page";
  path: string;
  label: string;
  description: string;
}

type PaletteEntity = PaletteTask | PaletteSession | PaletteAsk | PalettePage;

// ---------------------------------------------------------------------------
// Static pages — matches NavSheet.tsx route list
// ---------------------------------------------------------------------------

const PAGES: PalettePage[] = [
  { type: "page", path: "/", label: "Home", description: "Dashboard overview" },
  { type: "page", path: "/agents", label: "Agents", description: "Sessions in flight" },
  { type: "page", path: "/workstreams", label: "Work Streams", description: "Active task workstreams" },
  { type: "page", path: "/tasks", label: "Task Graph", description: "Dependency graph view" },
  { type: "page", path: "/tasks/list", label: "Task List", description: "Flat sortable task table" },
];

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchTaskList(): Promise<PaletteTask[]> {
  try {
    const res = await fetch("/api/tasks");
    if (!res.ok) return [];
    const data = (await res.json()) as { tasks: { id: string; title: string; status: string }[] };
    if (!Array.isArray(data.tasks)) return [];
    return data.tasks.map((t) => ({ type: "task" as const, ...t }));
  } catch {
    return [];
  }
}

function extractSessions(data: WidgetData | undefined): PaletteSession[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as {
    agents?: {
      sessionId: string;
      taskId: string | null;
      taskTitle: string | null;
      liveness: string;
    }[];
  };
  if (!Array.isArray(payload?.agents)) return [];
  return payload.agents.map((a) => ({
    type: "session" as const,
    id: a.sessionId,
    taskId: a.taskId,
    taskTitle: a.taskTitle,
    liveness: a.liveness,
  }));
}

function extractAsks(data: WidgetData | undefined): PaletteAsk[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as {
    cohort?: {
      id: string;
      title: string;
      kind: string;
      parentTaskId?: string;
    }[];
  };
  if (!Array.isArray(payload?.cohort)) return [];
  return payload.cohort.map((a) => ({
    type: "ask" as const,
    id: a.id,
    title: a.title,
    kind: a.kind,
    parentTaskId: a.parentTaskId ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Entity type badge — single-letter indicator per entity type
// ---------------------------------------------------------------------------

const TYPE_BADGE_CONFIG: Record<string, { letter: string; className: string }> = {
  task: { letter: "T", className: "bg-primary/20 text-primary" },
  session: { letter: "S", className: "bg-accent text-accent-foreground" },
  ask: { letter: "A", className: "bg-destructive/20 text-destructive" },
  page: { letter: "P", className: "bg-muted text-muted-foreground" },
};

function TypeBadge({ type }: { type: string }) {
  const cfg = TYPE_BADGE_CONFIG[type] ?? TYPE_BADGE_CONFIG["page"]!;
  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded text-xs font-mono font-semibold flex-shrink-0 ${cfg.className}`}
      aria-label={type}
    >
      {cfg.letter}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0">
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// CommandPalette component
// ---------------------------------------------------------------------------

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Global Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (!open) {
          previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
        }
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Restore focus to previously-focused element when palette closes
  useEffect(() => {
    if (!open && previouslyFocusedRef.current) {
      const el = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      requestAnimationFrame(() => el.focus());
    }
  }, [open]);

  // Load recent items when palette opens
  useEffect(() => {
    if (open) {
      setRecentItems(getRecentItems());
    }
  }, [open]);

  // Data queries — only active when palette is open
  const tasksQuery = useQuery({
    queryKey: ["command-palette-tasks"],
    queryFn: fetchTaskList,
    enabled: open,
    staleTime: 30_000,
  });

  const agentsQuery = useQuery<WidgetData, Error>({
    queryKey: ["agents"],
    queryFn: () => fetchWidgetData("agents"),
    enabled: open,
    staleTime: 30_000,
  });

  const attentionQuery = useQuery<WidgetData, Error>({
    queryKey: ["attention"],
    queryFn: () => fetchWidgetData("attention"),
    enabled: open,
    staleTime: 30_000,
  });

  const tasks = tasksQuery.data ?? [];
  const sessions = extractSessions(agentsQuery.data);
  const asks = extractAsks(attentionQuery.data);

  const handleSelect = useCallback(
    (entity: PaletteEntity) => {
      let path: string;
      let label: string;
      let entityId: string;

      switch (entity.type) {
        case "task":
          path = `/tasks?highlight=${encodeURIComponent(entity.id)}`;
          label = `${entity.id}: ${entity.title}`;
          entityId = entity.id;
          break;
        case "session":
          path = `/agents?highlight=${encodeURIComponent(entity.id)}`;
          label = entity.taskTitle ?? entity.id;
          entityId = entity.id;
          break;
        case "ask":
          path = `/?ask=${encodeURIComponent(entity.id)}`;
          label = entity.title;
          entityId = entity.id;
          break;
        case "page":
          path = entity.path;
          label = entity.label;
          entityId = entity.path;
          break;
      }

      addRecentItem({ type: entity.type, id: entityId, label, path });
      setOpen(false);
      navigate(path);
    },
    [navigate]
  );

  const handleRecentSelect = useCallback(
    (item: RecentItem) => {
      addRecentItem(item);
      setOpen(false);
      navigate(item.path);
    },
    [navigate]
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search tasks, sessions, asks, pages..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Recent items — shown first; cmdk filters them when user types */}
        {recentItems.length > 0 && (
          <>
            <CommandGroup heading="Recent">
              {recentItems.map((item) => (
                <CommandItem
                  key={`recent-${item.id}`}
                  value={`recent ${item.label} ${item.id}`}
                  onSelect={() => handleRecentSelect(item)}
                >
                  <TypeBadge type={item.type} />
                  <span className="ml-2 truncate">{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {/* Pages */}
        <CommandGroup heading="Pages">
          {PAGES.map((page) => (
            <CommandItem
              key={page.path}
              value={`page ${page.label} ${page.description}`}
              onSelect={() => handleSelect(page)}
            >
              <TypeBadge type="page" />
              <span className="ml-2">{page.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">{page.description}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {/* Tasks */}
        {tasks.length > 0 && (
          <CommandGroup heading="Tasks">
            {tasks.map((task) => (
              <CommandItem
                key={task.id}
                value={`task ${task.id} ${task.title}`}
                onSelect={() => handleSelect(task)}
              >
                <TypeBadge type="task" />
                <span className="ml-2 font-mono text-xs flex-shrink-0">{task.id}</span>
                <span className="ml-2 truncate">{task.title}</span>
                <StatusBadge status={task.status} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Sessions */}
        {sessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {sessions.map((session) => (
              <CommandItem
                key={session.id}
                value={`session ${session.id} ${session.taskId ?? ""} ${session.taskTitle ?? ""}`}
                onSelect={() => handleSelect(session)}
              >
                <TypeBadge type="session" />
                <span className="ml-2 truncate">{session.taskTitle ?? session.id}</span>
                {session.taskId && (
                  <span className="ml-2 text-xs text-muted-foreground flex-shrink-0">
                    {session.taskId}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Asks */}
        {asks.length > 0 && (
          <CommandGroup heading="Asks">
            {asks.map((ask) => (
              <CommandItem
                key={ask.id}
                value={`ask ${ask.id} ${ask.title} ${ask.kind}`}
                onSelect={() => handleSelect(ask)}
              >
                <TypeBadge type="ask" />
                <span className="ml-2 truncate">{ask.title}</span>
                <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">
                  {ask.kind}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
