/**
 * useProjectTriageSummaries — per-project (+ aggregate) triage summaries for
 * the project switcher (mt#4795).
 *
 * From the /product-thinking derivation of 2026-08-30 (following the
 * mt#4757 audit): the cockpit does not need a dedicated project-aware
 * landing page — that value routes into the affordance that already owns
 * choosing a project. Each option in the "Filter by project" switcher gains
 * a one-line muted triage summary ("Minsky — 40 need you · 3 working" /
 * "Peezombie.me — clear"); the "All projects" option aggregates.
 *
 * This hook composes the SAME scoped widget endpoints already powering the
 * shell's ask-pending pulse (`GET /api/widget/attention/data`, the
 * `totalPending` field — see `useOpenAskCount.ts`) and the home fleet strip
 * (`GET /api/widget/agents/data`, counting `liveness === "healthy"` rows —
 * see `HomePage.tsx`'s `countFleet`) — no new server endpoint, per the
 * spec's explicit scale-up deferral (an aggregation endpoint is only worth
 * building once project count grows past ~5).
 *
 * Queries only run while `enabled` is true (the switcher's dropdown-open
 * state) — the per-project fan-out costs nothing while the switcher is
 * closed, matching the spec's "fetched on dropdown open or mount" design
 * note without adding constant background polling for a summary line that
 * is only ever visible while the dropdown is open.
 *
 * A failed fetch for a scope renders `{ status: "degraded" }` — NEVER
 * silently folded into a "clear" (zero) result. This is spec SC2: honest
 * degradation over fake health (no fake calm).
 */
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";
import type { ProjectSummary } from "../lib/project-context";

/**
 * Sentinel key for the "All projects" aggregate row — mirrors
 * `ProjectSelector`'s own `ALL_PROJECTS_VALUE` sentinel (kept as a separate
 * constant rather than a shared import: that one is a Radix `<Select>`
 * value-boundary sentinel, this one is a query-result lookup key, and the
 * two live at different layers even though they currently share a value).
 */
export const ALL_PROJECTS_TRIAGE_KEY = "__all__";

export interface ProjectTriageSummary {
  /** Pending asks bound to this project scope (attention widget `totalPending`). */
  pendingCount: number;
  /** Workspace sessions with `liveness === "healthy"` in this project scope. */
  workingCount: number;
}

export type ProjectTriageResult =
  | { status: "loading" }
  | { status: "degraded" }
  | { status: "ok"; summary: ProjectTriageSummary };

interface AttentionPayload {
  totalPending: number;
}

/** Structural subset of the agents widget payload — see `Agents.tsx`'s `AgentsPayload`. */
interface AgentsPayloadSlim {
  agents?: Array<{ liveness: string | null }>;
}

type ScopeParams = { project: string } | undefined;
type ScopeOptions = { global?: boolean } | undefined;

async function fetchPendingCount(params: ScopeParams, options: ScopeOptions): Promise<number> {
  const data = await fetchWidgetData("attention", params, options);
  if (data.state !== "ok") {
    throw new Error(`attention widget degraded: ${data.reason}`);
  }
  const payload = data.payload as AttentionPayload;
  return typeof payload.totalPending === "number" ? payload.totalPending : 0;
}

async function fetchWorkingCount(params: ScopeParams, options: ScopeOptions): Promise<number> {
  const data = await fetchWidgetData("agents", params, options);
  if (data.state !== "ok") {
    throw new Error(`agents widget degraded: ${data.reason}`);
  }
  const payload = data.payload as AgentsPayloadSlim;
  if (!Array.isArray(payload.agents)) return 0;
  return payload.agents.reduce((n, a) => (a.liveness === "healthy" ? n + 1 : n), 0);
}

interface Scope {
  key: string;
  params: ScopeParams;
  options: ScopeOptions;
}

/**
 * Fetches a pending-count + working-count pair for each known project plus
 * an "All projects" aggregate.
 *
 * The aggregate scope passes `{ global: true }` so it reads the TRUE
 * cross-project total regardless of whichever project happens to be
 * currently selected — `apiFetch`'s default-append would otherwise scope an
 * unparented fetch to the CURRENT shell selection (see `api-client.ts`'s
 * docblock), which is exactly wrong for a row whose whole point is "every
 * project, aggregated." A per-project scope passes an explicit `project`
 * param instead, which always wins over that same default regardless of
 * the current shell selection.
 */
export function useProjectTriageSummaries(
  projects: ProjectSummary[],
  enabled: boolean
): Record<string, ProjectTriageResult> {
  const scopes: Scope[] = [
    { key: ALL_PROJECTS_TRIAGE_KEY, params: undefined, options: { global: true } },
    ...projects.map((p) => ({ key: p.slug, params: { project: p.slug }, options: undefined })),
  ];

  const results = useQueries({
    queries: scopes.flatMap((scope) => [
      {
        queryKey: ["project-triage", "pending", scope.key],
        queryFn: () => fetchPendingCount(scope.params, scope.options),
        enabled,
        staleTime: 5_000,
        refetchInterval: 10_000,
      },
      {
        queryKey: ["project-triage", "working", scope.key],
        queryFn: () => fetchWorkingCount(scope.params, scope.options),
        enabled,
        staleTime: 5_000,
        refetchInterval: 10_000,
      },
    ]),
  }) as UseQueryResult<number, Error>[];

  const out: Record<string, ProjectTriageResult> = {};
  scopes.forEach((scope, i) => {
    const pendingQuery = results[i * 2];
    const workingQuery = results[i * 2 + 1];
    if (!pendingQuery || !workingQuery) {
      out[scope.key] = { status: "loading" };
      return;
    }
    if (pendingQuery.isError || workingQuery.isError) {
      out[scope.key] = { status: "degraded" };
    } else if (pendingQuery.isSuccess && workingQuery.isSuccess) {
      out[scope.key] = {
        status: "ok",
        summary: {
          pendingCount: pendingQuery.data ?? 0,
          workingCount: workingQuery.data ?? 0,
        },
      };
    } else {
      out[scope.key] = { status: "loading" };
    }
  });

  return out;
}

/**
 * Render the muted triage line for a resolved summary — "N need you · M
 * working", degrading to just one clause when the other is zero, and
 * "clear" when both are zero. Exported for direct unit testing (mirrors
 * `fleet-groups.ts`'s precedent of testing exported pure helpers rather
 * than the stateful hook/component).
 */
export function formatTriageLine(summary: ProjectTriageSummary): string {
  const parts: string[] = [];
  if (summary.pendingCount > 0) parts.push(`${summary.pendingCount} need you`);
  if (summary.workingCount > 0) parts.push(`${summary.workingCount} working`);
  return parts.length > 0 ? parts.join(" · ") : "clear";
}

/** Muted marker for a scope whose fetch failed — never a fabricated "clear" (spec SC2). */
export const TRIAGE_DEGRADED_LABEL = "status unavailable";
