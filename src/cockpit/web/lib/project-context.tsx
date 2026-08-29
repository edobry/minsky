/**
 * Project-selection state for the Cockpit shell (mt#2418 — Phase 1.5 of
 * mt#2391).
 *
 * A single Postgres can hold rows from several projects (ADR-021). This
 * context holds the operator's CURRENTLY SELECTED project — `null` means
 * "All projects" (the pre-mt#2418 default, mt#2416's explicit cross-project
 * opt-out) — and every scoped widget/page reads it via `useProject()` to
 * append `?project=<slug>` to its fetch.
 *
 * Persistence model mirrors `lib/tabs.tsx` (mt#2398): plain localStorage,
 * not URL query params. The cockpit daemon is per-workspace already (one
 * daemon + port per workspace key), so a bare storage key is per-workspace
 * in effect. URL-param persistence was considered and rejected here because
 * the selected project is a CROSS-CUTTING filter (every rail link, tab, and
 * deep link would need to thread `?project=` through to survive navigation)
 * — localStorage gives "survives navigation" for free, matching the tab
 * strip's precedent, at the cost of not being independently shareable via a
 * URL (acceptable: the spec's persistence requirement is "survives
 * navigation," not "shareable via link").
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";

export interface ProjectSummary {
  id: string;
  slug: string;
  displayName: string | null;
}

interface ProjectsResponse {
  projects: ProjectSummary[];
}

async function fetchProjects(): Promise<ProjectSummary[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) {
    throw new Error(`Failed to load projects: ${res.status}`);
  }
  const body = (await res.json()) as ProjectsResponse;
  return Array.isArray(body.projects) ? body.projects : [];
}

// localStorage key name, not a credential — gitleaks generic-api-key
// false-positives on the `*KEY = "<string>"` shape (mirrors lib/tabs.tsx).
const STORAGE_KEY = "cockpit.project.v1"; // gitleaks:allow

/**
 * Read the persisted project selection directly, bypassing React context.
 *
 * Exported (mt#4730) so `lib/api-client.ts`'s `apiFetch` can default-append
 * `?project=` to every request without needing a hook call — `apiFetch` is a
 * plain async function usable from non-component code (event handlers,
 * other lib modules), so it cannot call `useProject()` itself. This is the
 * SAME source of truth `ProjectProvider` reads on mount; the two never
 * diverge because there is only one persisted value.
 */
export function loadPersistedSlug(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return typeof raw === "string" && raw.trim() !== "" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Pure derivation of the fetch-ready query-param object from a selected
 * slug. Exported for direct unit testing (Bun has no `renderHook` — see
 * `lib/tabs.tsx`'s precedent of testing exported pure helpers rather than
 * the stateful provider component).
 */
export function deriveQueryParam(selectedSlug: string | null): { project: string } | undefined {
  return selectedSlug ? { project: selectedSlug } : undefined;
}

/**
 * True when `slug` names a project in `projects` (or `slug` is `null` —
 * "All projects" is always valid). Exported for direct unit testing; used by
 * `ProjectProvider` to fall back to "All projects" when a persisted slug no
 * longer names a known project (deleted project, or a stale localStorage
 * value from a different daemon instance).
 */
export function isKnownSlug(projects: ProjectSummary[], slug: string | null): boolean {
  if (slug === null) return true;
  return projects.some((p) => p.slug === slug);
}

// ---------------------------------------------------------------------------
// Project-badge helpers (mt#4729) — shared by TaskList / Changesets /
// RunDetail row rendering, so the "when to show" rule and the "what label"
// rule each live in exactly one place rather than being reimplemented per
// widget.
// ---------------------------------------------------------------------------

/**
 * True when a project indicator is worth rendering: the all-projects view
 * (no project explicitly selected) AND 2+ projects actually exist. A single
 * known project, or an explicit selection, makes a per-row badge pure noise
 * — there is nothing left to distinguish (mission-control density: no
 * indicator with no useful state to convey). Mirrors the same threshold
 * `ProjectSelector` already uses to decide whether to render itself at all.
 */
export function shouldShowProjectIndicator(
  projects: ProjectSummary[],
  selectedSlug: string | null
): boolean {
  return selectedSlug === null && projects.length >= 2;
}

/**
 * Resolve a project slug (as carried on e.g. `TaskListItem.project`, or a
 * session/changeset row's `repoName`) to a human-readable label —
 * `displayName` when the shell knows a project by that slug, else the slug
 * itself (which is already a valid identifier per mt#4729 SC1 — no reason
 * to degrade to null just because `/api/projects` hasn't resolved a nicer
 * name for it yet, e.g. a race with that fetch, or a project the shell's
 * list doesn't (yet) include).
 */
export function projectLabelBySlug(
  projects: ProjectSummary[],
  slug: string | null
): string | null {
  if (!slug) return null;
  const project = projects.find((p) => p.slug === slug);
  return project?.displayName ?? slug;
}

interface ProjectContextValue {
  /** Every known project (empty while loading, or when none exist). */
  projects: ProjectSummary[];
  /** True while the initial project list fetch is in flight. */
  isLoading: boolean;
  /** The currently selected project's slug, or `null` for "All projects". */
  selectedSlug: string | null;
  /** Select a project by slug, or `null` to select "All projects". */
  setSelectedSlug: (slug: string | null) => void;
  /**
   * Query-param object ready to spread into a fetch call — `{ project:
   * slug }` when a project is selected, `undefined` for "All projects" (an
   * absent param, not the "all" sentinel string, matches the backend's own
   * "omitted -> ALL_PROJECTS" default so unscoped consumers are unaffected).
   */
  queryParam: { project: string } | undefined;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [selectedSlug, setSelectedSlugState] = useState<string | null>(loadPersistedSlug);

  const { data: projects, isLoading } = useQuery<ProjectSummary[], Error>({
    queryKey: ["projects"],
    queryFn: fetchProjects,
    staleTime: 5 * 60_000,
  });

  // Persist on every change; storage failures are non-fatal (selection
  // becomes session-ephemeral, matching lib/tabs.tsx's degradation posture).
  useEffect(() => {
    try {
      if (selectedSlug) {
        localStorage.setItem(STORAGE_KEY, selectedSlug);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [selectedSlug]);

  const projectList = useMemo(() => projects ?? [], [projects]);

  // If the persisted slug no longer names a known project (e.g. it was
  // deleted, or this is a fresh workspace whose localStorage carries a
  // slug from a different daemon instance), fall back to "All projects"
  // rather than silently filtering to a scope that can never match —
  // once the project list has actually loaded.
  useEffect(() => {
    if (isLoading || !selectedSlug) return;
    if (projectList.length === 0) return;
    if (!isKnownSlug(projectList, selectedSlug)) {
      setSelectedSlugState(null);
    }
  }, [isLoading, projectList, selectedSlug]);

  const setSelectedSlug = useCallback((slug: string | null) => {
    setSelectedSlugState(slug);
  }, []);

  const queryParam = useMemo(() => deriveQueryParam(selectedSlug), [selectedSlug]);

  const value = useMemo<ProjectContextValue>(
    () => ({ projects: projectList, isLoading, selectedSlug, setSelectedSlug, queryParam }),
    [projectList, isLoading, selectedSlug, setSelectedSlug, queryParam]
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject must be used within a ProjectProvider");
  }
  return ctx;
}
