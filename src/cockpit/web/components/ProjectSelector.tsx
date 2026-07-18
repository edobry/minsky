/**
 * ProjectSelector — Cockpit shell project filter (mt#2418 — Phase 1.5 of
 * mt#2391).
 *
 * A single Postgres can hold rows from several projects (ADR-021). This
 * dropdown lets the operator view one project's data at a time, or "All
 * projects" (mt#2416's explicit cross-project opt-out, and the pre-mt#2418
 * default). Selection is held in `ProjectProvider` (lib/project-context.tsx)
 * and persists across navigation via localStorage, mirroring the tab strip's
 * persistence model (lib/tabs.tsx).
 *
 * Placement: the Rail header, alongside the wordmark — a shell-level
 * concern that applies to every page, not a per-widget control (cockpit-design
 * skill: shell-level filters live in the persistent chrome, not duplicated
 * per page/widget).
 *
 * Renders nothing when zero or one project is known — a single-project
 * deployment (the common case pre-mt#2391) has nothing to filter, so the
 * control would be pure noise (mission-control density: don't show a
 * control with no useful state to select between).
 */
import { useProject } from "../lib/project-context";

const ALL_PROJECTS_VALUE = "";

export function ProjectSelector() {
  const { projects, selectedSlug, setSelectedSlug, isLoading } = useProject();

  if (isLoading || projects.length < 2) {
    return null;
  }

  return (
    <div className="flex-shrink-0 border-b border-border px-2 py-2">
      <select
        value={selectedSlug ?? ALL_PROJECTS_VALUE}
        onChange={(e) =>
          setSelectedSlug(e.target.value === ALL_PROJECTS_VALUE ? null : e.target.value)
        }
        className="w-full text-xs bg-muted border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Filter by project"
        title="Filter the cockpit to one project, or view all projects"
      >
        <option value={ALL_PROJECTS_VALUE}>All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.slug}>
            {p.displayName ?? p.slug}
          </option>
        ))}
      </select>
    </div>
  );
}
