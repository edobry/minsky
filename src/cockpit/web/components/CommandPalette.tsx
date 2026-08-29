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
 * PRs join as a search source (mt#2536 wired changeset linkification;
 * the /changeset/:n detail route is mt#2535).
 *
 * Actions (mt#3464). The palette shipped navigation-only: every item resolved
 * to a path, so there was no way to express "do a thing" here at all. The
 * `PaletteAction` type below is that mechanism — an item that RUNS instead of
 * navigating — and "New conversation" is its first (and currently only)
 * member. Each action renders its keyboard shortcut, per the teach-the-
 * shortcut pattern: the palette is how an operator discovers the chord, and
 * the chord is how they stop needing the palette.
 *
 * REQUIRES `<NewConversationProvider>` as an ancestor (PR #2477 R1). `Layout`
 * mounts it around the whole shell, so every production render is covered;
 * mounting this component outside that tree THROWS rather than degrading.
 * That is deliberate — a missing provider is a wiring bug, and the quiet
 * alternative (each surface falling back to its own mutation instance) is the
 * double-fire-and-silent-failure pair the provider exists to prevent. A test
 * that renders the palette standalone must wrap it; see
 * `widgets/command-palette.test.tsx`.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { extractConversationRows } from "../lib/conversations-source";
import type { TaskIndexRow } from "../lib/entity-labels";
import { useProject } from "../lib/project-context";
import { useNewConversation } from "../hooks/useNewConversation";
import {
  NEW_CONVERSATION_DESCRIPTION,
  NEW_CONVERSATION_HINT,
  NEW_CONVERSATION_LABEL,
} from "../lib/new-conversation";

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
  /** `ask#N` (ADR-029) — null for legacy rows predating the backfill. */
  shortId: string | null;
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

interface PaletteConversation {
  type: "conversation";
  /** Harness agentSessionId — distinct id-space from PaletteSession.id (workspace sessionId). */
  id: string;
  label: string;
  cwd: string | null;
}

interface PalettePage {
  type: "page";
  path: string;
  label: string;
  description: string;
}

/**
 * An item that RUNS instead of navigating (mt#3464). Deliberately NOT part of
 * the `PaletteEntity` union below: every member of that union resolves to a
 * path through `entityToPath`, and an action has none — folding it in would
 * mean a `type === "action"` hole in the one function whose whole job is
 * (type, id) → path.
 */
interface PaletteAction {
  type: "action";
  id: string;
  label: string;
  description: string;
  /** Rendered shortcut hint — how the operator learns to skip the palette. */
  hint: string;
  run: () => void;
}

type PaletteEntity =
  | PaletteTask
  | PaletteSession
  | PaletteAsk
  | PaletteMemory
  | PaletteConversation
  | PalettePage;

// ---------------------------------------------------------------------------
// Static pages — aligned with the rail's route list, plus finer granularity
// (separate Task List + Task Graph entries) for direct keyboard jumps.
// ---------------------------------------------------------------------------

const PAGES: PalettePage[] = [
  { type: "page", path: "/", label: "Home", description: "Dashboard overview" },
  {
    type: "page",
    path: "/agents",
    label: "Agents",
    description: "Unified agent-run list (mt#2767): workspace sessions, conversations, subagents",
  },
  {
    type: "page",
    path: "/workstreams",
    label: "Work Streams",
    description: "Active task workstreams",
  },
  { type: "page", path: "/tasks", label: "Task List", description: "Flat sortable task table" },
  { type: "page", path: "/tasks/graph", label: "Task Graph", description: "Dependency graph view" },
  {
    type: "page",
    path: "/changesets",
    label: "Changesets",
    description: "Active PRs across sessions",
  },
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
  {
    type: "page",
    path: "/shares",
    label: "Shared links",
    description: "Conversations published as public read-only links",
  },
];

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

function extractSessions(data: WidgetData | undefined): PaletteSession[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as {
    agents?: {
      sessionId: string;
      kind?: string;
      taskId: string | null;
      taskTitle: string | null;
      liveness: string | null;
    }[];
  };
  if (!Array.isArray(payload?.agents)) return [];
  // mt#2767 — the `agents` widget now ALSO returns conversation-derived rows
  // (kind: "principal-conversation" | "subagent-group") in the same array.
  // Those are already indexed separately below via the "Conversations" group
  // (context-inspector source) — keep "Sessions" scoped to workspace rows
  // only, so the palette doesn't show the same conversation twice under two
  // different headings. Rows without a `kind` field (impossible post-mt#2767,
  // kept only as a defensive default) are treated as workspace rows.
  return payload.agents
    .filter((a) => a.kind == null || a.kind === "dispatched-agent")
    .map((a) => ({
      type: "session" as const,
      id: a.sessionId,
      taskId: a.taskId,
      taskTitle: a.taskTitle,
      liveness: a.liveness ?? "unknown",
    }));
}

/**
 * The palette's OWN task index — a dedicated, project-scoped fetch (mt#4731),
 * distinct from `entity-labels.ts`'s `fetchTaskIndex` / `TASK_INDEX_QUERY_KEY`.
 * That shared fetcher backs cross-entity LINKIFICATION (tab labels, the
 * entity-index id-set) and stays deliberately global — resolving a bare
 * `mt#N` reference must work regardless of which project is selected. Palette
 * SEARCH is a different concern: typing into ⌘K while a project is selected
 * should search that project's tasks, so it gets its own key + query param
 * rather than sharing the global cache.
 */
async function fetchPaletteTasks(queryParam?: { project: string }): Promise<TaskIndexRow[]> {
  try {
    const qs = queryParam ? `?project=${encodeURIComponent(queryParam.project)}` : "";
    const res = await fetch(`/api/tasks${qs}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { tasks?: TaskIndexRow[] };
    if (!Array.isArray(data.tasks)) return [];
    return data.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
  } catch {
    return [];
  }
}

/**
 * The palette's ask index — pending AND terminal (mt#4095).
 *
 * Sourced from `GET /api/asks?state=...&summary=true`, not from the attention
 * widget's cohort. That cohort is the radiator feed (pending operator asks in
 * the active service window), so this palette advertised "Search ... asks ..."
 * while being structurally unable to find one the operator had already
 * resolved — which is precisely when someone reaches for search.
 *
 * Preloaded and filtered client-side by cmdk, matching how the palette already
 * treats tasks (`fetchPaletteTasks` loads the full list). `summary=true` is
 * what makes that affordable: a full row carries its question body and
 * options at ~3.3 KB, a summary row is scalars.
 *
 * Fails open to `[]` — an asks-endpoint hiccup must not break palette search
 * for the other entity types.
 */
async function fetchPaletteAsks(queryParam?: { project: string }): Promise<PaletteAsk[]> {
  try {
    const params = new URLSearchParams({
      // Both halves in one request. `suspended` is the pending queue; the
      // terminal alias expands to closed/cancelled/expired, because someone
      // hunting a resolved ask does not know which of the three it landed in.
      state: "suspended,terminal",
      summary: "true",
      limit: "2000",
      ...(queryParam ? { project: queryParam.project } : {}),
    });
    const res = await fetch(`/api/asks?${params.toString()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      asks?: { id: string; shortId?: string; title: string; kind: string; parentTaskId?: string }[];
    };
    if (!Array.isArray(data?.asks)) return [];
    return data.asks.map((a) => ({
      type: "ask" as const,
      id: a.id,
      shortId: a.shortId ?? null,
      title: a.title,
      kind: a.kind,
      parentTaskId: a.parentTaskId ?? null,
    }));
  } catch {
    return [];
  }
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

/**
 * Extract conversation rows (harness agentSessionIds) from the shared
 * context-inspector conversations-picker payload — reuses `ConversationRow`
 * from `lib/conversations-source.ts` as-is (mt#2769, mt#2770 is enriching
 * that source's `label` field concurrently; this consumes it read-only).
 */
function extractConversations(data: WidgetData | undefined): PaletteConversation[] {
  return extractConversationRows(data).map((row) => ({
    type: "conversation" as const,
    id: row.agentSessionId,
    label: row.label,
    cwd: row.cwd,
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
  conversation: { letter: "C", className: "bg-sky-500/20 text-sky-500" },
  page: { letter: "P", className: "bg-muted text-muted-foreground" },
  // A command-prompt caret rather than a letter: actions are a different
  // KIND of row, not another entity type, and every letter that reads as
  // "action" is already taken (A = ask).
  action: { letter: ">", className: "bg-primary text-primary-foreground" },
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
  const newConversation = useNewConversation();
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

  // Data queries — only active when palette is open. mt#4731: all four
  // entity-search sources below are project-scoped via useProject(), with
  // their OWN dedicated keys — distinct from lib/entity-labels.ts's /
  // lib/use-entity-index.ts's shared, deliberately-global fetchers (tab
  // labels and cross-project linkification must resolve a bare id
  // regardless of the selected project; palette SEARCH should not).
  const { selectedSlug, queryParam } = useProject();

  const tasksQuery = useQuery({
    queryKey: ["palette", "tasks", selectedSlug],
    queryFn: () => fetchPaletteTasks(queryParam),
    enabled: open,
    staleTime: 30_000,
  });

  const agentsQuery = useQuery<WidgetData, Error>({
    queryKey: ["agents", selectedSlug],
    queryFn: () => fetchWidgetData("agents", queryParam),
    enabled: open,
    staleTime: 30_000,
  });

  // Distinct key from ["attention"] — that one is the radiator widget's
  // payload and carries pending asks only (mt#4095).
  const asksQuery = useQuery<PaletteAsk[], Error>({
    queryKey: ["palette", "asks", selectedSlug],
    queryFn: () => fetchPaletteAsks(queryParam),
    enabled: open,
    staleTime: 30_000,
  });

  const memoriesQuery = useQuery<WidgetData, Error>({
    queryKey: ["palette", "memories-list", selectedSlug],
    queryFn: () => fetchWidgetData("memories-list", { excludeSuperseded: "true", ...queryParam }),
    enabled: open,
    staleTime: 30_000,
  });

  // Shared key with ConversationPage / useEntityIndex's ["context-inspector", "sessions"]
  // (the retired ConversationsPage list used the same key pre-mt#2767) —
  // same raw WidgetData wrapper, different projection extracted (mt#2769).
  const conversationsQuery = useQuery<WidgetData, Error>({
    queryKey: ["context-inspector", "sessions"],
    queryFn: () => fetchWidgetData("context-inspector"),
    enabled: open,
    staleTime: 30_000,
  });

  const tasks: PaletteTask[] = (tasksQuery.data ?? []).map((t) => ({
    type: "task" as const,
    ...t,
  }));
  const sessions = extractSessions(agentsQuery.data);
  const asks = asksQuery.data ?? [];
  const memories = extractMemories(memoriesQuery.data);
  const conversations = extractConversations(conversationsQuery.data);

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

  // Actions run instead of navigating (mt#3464). Close the palette FIRST so
  // the overlay is gone before the action's own effect (here: navigation to
  // the new conversation) lands.
  const actions = useMemo<PaletteAction[]>(
    () => [
      {
        type: "action",
        id: "new-conversation",
        label: NEW_CONVERSATION_LABEL,
        description: NEW_CONVERSATION_DESCRIPTION,
        hint: NEW_CONVERSATION_HINT,
        run: newConversation.start,
      },
    ],
    [newConversation.start]
  );

  const handleAction = useCallback((action: PaletteAction) => {
    setOpen(false);
    action.run();
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search tasks, sessions, conversations, asks, memories, pages..."
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

            {/* Actions — run, don't navigate (mt#3464). Listed first: an
                action is what the operator came to DO, whereas the groups
                below are places to go. */}
            <CommandGroup heading="Actions">
              {actions.map((action) => (
                <CommandItem
                  key={action.id}
                  value={`action ${action.label} ${action.description}`}
                  onSelect={() => handleAction(action)}
                >
                  <TypeBadge type="action" />
                  <span className="ml-2">{action.label}</span>
                  <span className="ml-2 truncate text-xs text-muted-foreground">
                    {action.description}
                  </span>
                  <kbd className="ml-auto flex-shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {action.hint}
                  </kbd>
                </CommandItem>
              ))}
            </CommandGroup>

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

            {/* Conversations (harness agentSessionIds — the /conversation id-space) */}
            {conversations.length > 0 && (
              <CommandGroup heading="Conversations">
                {conversations.map((conversation) => (
                  <CommandItem
                    key={conversation.id}
                    value={`conversation ${conversation.id} ${conversation.label} ${conversation.cwd ?? ""}`}
                    onSelect={() => handleSelect(conversation)}
                  >
                    <TypeBadge type="conversation" />
                    <span className="ml-2 truncate">{conversation.label}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground flex-shrink-0">
                      {conversation.id.slice(0, 8)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Asks. The match string carries `shortId` (mt#4095) — cmdk
                filters on `value`, so typing `ask#7754` can only find a row
                whose value contains it, and before mt#4095 it never did. */}
            {asks.length > 0 && (
              <CommandGroup heading="Asks">
                {asks.map((ask) => (
                  <CommandItem
                    key={ask.id}
                    value={`ask ${ask.shortId ?? ""} ${ask.id} ${ask.title} ${ask.kind}`}
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
