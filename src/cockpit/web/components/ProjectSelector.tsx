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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

/**
 * Non-empty on purpose (mt#3347): Radix spells "no value" as `""`, so an item
 * with `value=""` is indistinguishable from an unset Select and the trigger
 * shows the placeholder instead of this option's label. `null` remains the
 * ProjectProvider-side representation of "all projects"; this sentinel exists
 * only at the control boundary.
 */
const ALL_PROJECTS_VALUE = "__all__";

export function ProjectSelector() {
  const { projects, selectedSlug, setSelectedSlug, isLoading } = useProject();

  if (isLoading || projects.length < 2) {
    return null;
  }

  return (
    <div className="flex-shrink-0 border-b border-border px-2 py-2">
      <Select
        value={selectedSlug ?? ALL_PROJECTS_VALUE}
        onValueChange={(v) => setSelectedSlug(v === ALL_PROJECTS_VALUE ? null : v)}
      >
        <SelectTrigger
          className="w-full"
          aria-label="Filter by project"
          title="Filter the cockpit to one project, or view all projects"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_PROJECTS_VALUE}>All projects</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.slug}>
              {p.displayName ?? p.slug}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
