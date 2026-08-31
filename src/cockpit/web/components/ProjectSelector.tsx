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
 *
 * Per-option triage summary (mt#4795): each option additionally renders a
 * muted one-line "N need you · M working" / "clear" summary beneath its
 * label, sourced from `useProjectTriageSummaries` — see that hook's
 * docblock for the data flow and the honest-degradation guarantee (spec
 * SC2). The summary is fetched only while the dropdown is open.
 */
import { useState } from "react";
import { useProject } from "../lib/project-context";
import {
  useProjectTriageSummaries,
  formatTriageLine,
  ALL_PROJECTS_TRIAGE_KEY,
  TRIAGE_DEGRADED_LABEL,
  type ProjectTriageResult,
} from "../hooks/useProjectTriageSummaries";
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

/**
 * Muted secondary line for one option, given its triage-fetch result.
 * `undefined` result (a scope that hasn't resolved into the summaries map
 * yet — should not normally happen once `enabled`, but degrades safely)
 * reads the same as "loading": no line rendered rather than a fabricated
 * default.
 */
function triageLineFor(result: ProjectTriageResult | undefined): string | null {
  if (!result) return null;
  if (result.status === "loading") return null;
  if (result.status === "degraded") return TRIAGE_DEGRADED_LABEL;
  return formatTriageLine(result.summary);
}

/**
 * One option's rendered body: primary label + muted triage line. Kept as
 * its own component so the triage `<span>` can be marked `aria-hidden` —
 * Radix's `SelectItem` wires `aria-labelledby` at the item root to its
 * `ItemText` content (name-from-content), so an `aria-hidden` descendant is
 * excluded from that computed accessible name, leaving the plain label as
 * the option's announced name (matches pre-mt#4795 behavior — see
 * ProjectSelector.test.tsx's `getByRole("option", { name: ... })`
 * assertions, unchanged by this feature).
 */
function OptionBody({ label, triageLine }: { label: string; triageLine: string | null }) {
  return (
    <span className="flex flex-col items-start gap-0.5 py-0.5">
      <span>{label}</span>
      {triageLine ? (
        <span className="text-[10px] leading-tight text-muted-foreground" aria-hidden="true">
          {triageLine}
        </span>
      ) : null}
    </span>
  );
}

export function ProjectSelector() {
  const { projects, selectedSlug, setSelectedSlug, isLoading } = useProject();
  const [open, setOpen] = useState(false);
  // Rules-of-hooks keeps this call unconditional, but there's no reason to
  // let it construct/register live queries for a selector that is about to
  // render null below (0 or 1 known project) — gate `enabled` on the same
  // condition the early return checks.
  const triageSummaries = useProjectTriageSummaries(projects, open && projects.length >= 2);

  if (isLoading || projects.length < 2) {
    return null;
  }

  const currentLabel =
    selectedSlug == null
      ? "All projects"
      : (projects.find((p) => p.slug === selectedSlug)?.displayName ?? selectedSlug);

  return (
    <div className="flex-shrink-0 border-b border-border px-2 py-2">
      <Select
        value={selectedSlug ?? ALL_PROJECTS_VALUE}
        onValueChange={(v) => setSelectedSlug(v === ALL_PROJECTS_VALUE ? null : v)}
        onOpenChange={setOpen}
      >
        <SelectTrigger
          className="w-full"
          aria-label="Filter by project"
          title="Filter the cockpit to one project, or view all projects"
        >
          {/*
           * Explicit children (mt#4795): without them, Radix portals the
           * SELECTED item's ItemText children verbatim into this node
           * (`valueNodeHasChildren` gates that portal off) — which would
           * leak the muted triage line into the CLOSED trigger. Passing the
           * plain label here keeps the closed-state combobox unchanged
           * (spec SC3), independent of what each option renders while open.
           */}
          <SelectValue>{currentLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_PROJECTS_VALUE}>
            <OptionBody
              label="All projects"
              triageLine={triageLineFor(triageSummaries[ALL_PROJECTS_TRIAGE_KEY])}
            />
          </SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.slug}>
              <OptionBody
                label={p.displayName ?? p.slug}
                triageLine={triageLineFor(triageSummaries[p.slug])}
              />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
