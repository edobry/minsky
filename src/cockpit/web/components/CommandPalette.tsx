/**
 * CommandPalette — ⌘K entity search → open as tab (mt#2399, shell C).
 *
 * Search + jump, not a hierarchical menu (cockpit-design §Command palette):
 * a transient cmdk overlay that searches across entities — tasks, workspace
 * sessions, asks, memories — and static pages, and opens the chosen entity
 * at its URL-addressable detail route, which the tab model (mt#2398) turns
 * into an entity tab on visit. Nothing renders until the operator types (no
 * recents-as-default; the former Recent group and its lib/recent-items
 * substrate were retired by mt#2399).
 *
 * PRs join as a source when a PR detail surface exists — mt#2410's spec
 * defers "/pr/:n" until then.
 */
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
} from "./ui/command";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { entityToPath } from "../lib/entity-codec";

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

interface PaletteMemory {
  type: "memory";
  id: string;
  name: string;
  memoryType: string;
}

interface PalettePage {
  type: "page";
  path: string;
  label: string;
  description: string;
}

type PaletteEntity = PaletteTask | PaletteSession | PaletteAsk | PaletteMemory | PalettePage;

// ---------------------------------------------------------------------------
// Static pages — aligned with the rail's route list, plus finer granularity
// (separate Task List + Task Graph entries) for direct keyboard jumps.
// ---------------------------------------------------------------------------

const PAGES: PalettePage[] = [
  { type: "page", path: "/", label: "Home", description: "Dashboard overview" },
  { type: "page", path: "/agents", label: "Agents", description: "Workspace sessions in flight" },
  { type: "page", path: "/sessions", label: "Sessions", description: "Conversation transcripts" },
  { type: "page", path: "/context", label: "Context", description: "Session context inspector" },
  {
    type: "page",
    path: "/workstreams",
    label: "Work Streams",
    description: "Active task workstreams",
  },
  { type: "page", path: "/tasks", label: "Task List", description: "Flat sortable task table" },
  { type: "page", path: "/tasks/graph", label: "Task Graph", description: "Dependency graph view" },
  { type: "page", path: "/changesets", label: "Changesets", description: "Active PRs across sessions" },
  { type: "page", path: "/asks", label: "Asks", description: "Pending principal-attention asks" },
  { type: "page", path: "/activity", label: "Activity", description: "System event log" },
  {
    type: "page",
    path: "/embeddings",
    label: "Embeddings",
    description: "Provider health & index coverage",
  },
  {
    type: "page",
    path: "/memories",
    label: "Memories",
    description: "Browse, search, and inspect memory records",
  },
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

function extractMemories(data: WidgetData | undefined): PaletteMemory[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as {
    records?: { id: string; name: string; type: string }[];
  };
  if (!Array.isArray(payload?.records)) return [];
  return payload.records.map((r) => ({
    type: "memory" as const,
    id: r.id,
    name: r.name,
    memoryType: r.type,
  }));
}

// ---------------------------------------------------------------------------
// Entity type badge — single-letter indicator per entity type
// ---------------------------------------------------------------------------

const TYPE_BADGE_CONFIG: Record<string, { letter: string; className: string }> = {
  task: { letter: "T", className: "bg-primary/20 text-primary" },
  session: { letter: "S", className: "bg-accent text-accent-foreground" },
  ask: { letter: "A", className: "bg-destructive/20 text-destructive" },
  memory: { letter: "M", className: "bg-emerald-500/20 text-emerald-500" },
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
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
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

  // Restore focus to previously-focused element when palette closes; reset
  // the query so reopening starts blank (nothing shown until typing).
  useEffect(() => {
    if (!open) {
      setQuery("");
      if (previouslyFocusedRef.current) {
        const el = previouslyFocusedRef.current;
        previouslyFocusedRef.current = null;
        requestAnimationFrame(() => el.focus());
      }
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

  const memoriesQuery = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-list", "", "", true],
    queryFn: () => fetchWidgetData("memories-list", { excludeSuperseded: "true" }),
    enabled: open,
    staleTime: 30_000,
  });

  const tasks = tasksQuery.data ?? [];
  const sessions = extractSessions(agentsQuery.data);
  const asks = extractAsks(attentionQuery.data);
  const memories = extractMemories(memoriesQuery.data);

  const hasQuery = query.trim().length > 0;

  const handleSelect = useCallback(
    (entity: PaletteEntity) => {
      // Entity selections land on the URL-addressable detail routes; the tab
      // model (mt#2398) opens them as entity tabs on visit. Path composition
      // is delegated to the shared entity codec (entity-codec.ts) — the single
      // source of truth for (type, id) → cockpit path.
      let path: string;
      if (entity.type === "page") {
        path = entity.path;
      } else {
        path = entityToPath(entity.type, entity.id);
      }

      setOpen(false);
      navigate(path);
    },
    [navigate]
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search tasks, sessions, asks, memories, pages..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {/* Nothing until typing — search + jump, no recents-as-default. */}
        {!hasQuery ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Type to search…</div>
        ) : (
          <>
            <CommandEmpty>No results found.</CommandEmpty>

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

            {/* Sessions (workspace sessions — the /agents id-space) */}
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

            {/* Memories */}
            {memories.length > 0 && (
              <CommandGroup heading="Memories">
                {memories.map((memory) => (
                  <CommandItem
                    key={memory.id}
                    value={`memory ${memory.id} ${memory.name} ${memory.memoryType}`}
                    onSelect={() => handleSelect(memory)}
                  >
                    <TypeBadge type="memory" />
                    <span className="ml-2 truncate">{memory.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">
                      {memory.memoryType}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
