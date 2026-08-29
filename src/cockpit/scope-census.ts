/**
 * Structural-enforcement census for cockpit project scoping (mt#4730).
 *
 * mt#2418 shipped `resolveCockpitProjectScope()`; adoption was per-author
 * discipline from then on — nothing stopped a new route or widget from
 * silently defaulting to unscoped. This module is the census that closes
 * that gap: it enumerates every LIVE route module (`src/cockpit/routes/*.ts`)
 * and every LIVE registered widget (`WIDGET_REGISTRY`) and requires each to
 * be either
 *
 *   (a) scope-consuming — its source text shows evidence of reading
 *       `req.projectScope` / `ctx.projectScope` (the mt#4730 middleware +
 *       WidgetContext field — see `project-scope.ts` and `types.ts`) or
 *       calling `resolveCockpitProjectScope` directly (the pre-existing,
 *       still-supported mechanism — see the docblock on
 *       `WidgetContext.projectScope` for why existing scoped widgets were
 *       NOT forced to migrate off their own call), OR
 *   (b) on the allowlist below, with a written reason.
 *
 * `scope-census.test.ts` is the actual enforcement: it fails when a live
 * module is neither. Pattern mirrors `.minsky/hooks/hook-module-inventory.test.ts`
 * — a mechanical census (the denominator is the live directory listing /
 * registry, not a hand-maintained count) over a judged classification
 * (whether a given surface's data is genuinely project-attributable is not
 * statically decidable — a person decided it, once, and recorded why here).
 *
 * ## Why "evidence in source text" and not "actually executes correctly"
 *
 * This is a STATIC census, not a runtime probe: it greps each module's own
 * source for the calls that would resolve a scope, the same way a lint rule
 * checks for a required pattern. It answers "did anyone make a scoping
 * DECISION for this surface" — not "is the resulting SQL filter correct".
 * Correctness of an individual scoped surface is covered by that surface's
 * own tests (e.g. the two-project-fixture tests mt#4727/mt#4728 added).
 *
 * ## Allowlist reason conventions
 *
 * Two shapes of reason appear below, both legitimate for "deliberately
 * global" per the mt#4730 spec, and distinguished in prose rather than by a
 * separate field (keeping the schema small):
 *
 *   - "not project-attributable: ..." — the surface's data has no project
 *     dimension even in principle (process/daemon status, a global registry,
 *     an id-addressed single-entity fetch that isn't a project-wide list).
 *     These will never move to the scoped column.
 *   - "deferred: ..." — the data COULD be scoped but currently isn't (a
 *     missing schema column, an unresolved repo→project join, etc.) and
 *     doing so is real feature work out of mt#4730's stated Scope ("OUT:
 *     threading the currently-missing surfaces"). Tracked at mt#4746.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WIDGET_REGISTRY } from "./widget-registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(HERE, "routes");
const WIDGETS_DIR = join(HERE, "widgets");

export interface AllowlistEntry {
  /** WIDGET_REGISTRY key, or route module filename without the `.ts` extension. */
  id: string;
  reason: string;
}

/**
 * Textual evidence that a module made a scoping decision. Matches either the
 * new mt#4730 context field (`ctx.projectScope` / `req.projectScope`) or the
 * pre-existing mt#2418 direct call (`resolveCockpitProjectScope`).
 */
const SCOPE_EVIDENCE_PATTERN = /resolveCockpitProjectScope|ctx\.projectScope|req\.projectScope/;

// ---------------------------------------------------------------------------
// Widgets — WIDGET_REGISTRY keys not listed here must show SCOPE_EVIDENCE_PATTERN
// in `widgets/<id>.ts`.
//
// Scope-consuming (verified via resolveCockpitProjectScope, mt#2418/mt#4727/mt#4728):
// agents, attention, context-inspector (mt#4746), driven-session-cost (mt#4746,
// task→project resolution — see its own docblock), memories-list, memories-search,
// memories-stats, reviewer-bot-status (mt#4746, PARTIAL — see its own docblock's
// "Project scope" section: reviewer_webhook_events carries no owner/repo column,
// so 4 of its ~15 queries stay global even when scoped), task-graph, task-list,
// workstreams.
// ---------------------------------------------------------------------------
export const WIDGET_ALLOWLIST: AllowlistEntry[] = [
  {
    id: "basic-health",
    reason: "not project-attributable: daemon process health (uptime, widget count).",
  },
  {
    id: "credentials",
    reason: "not project-attributable: credentials are stored globally, not per-project.",
  },
  {
    id: "embeddings-health",
    reason: "not project-attributable: process-level embeddings-provider health singleton.",
  },
  {
    id: "guard-health",
    reason: "not project-attributable: process-level guard/hook health tracker singleton.",
  },
  {
    id: "interceptor-aggregates",
    reason: "not project-attributable: aggregated by guard name, a daemon-wide registry key.",
  },
  {
    id: "interceptors",
    reason:
      "not project-attributable: the interceptor catalog is a daemon-wide registry, not project data.",
  },
  {
    id: "mcp-server-status",
    reason: "not project-attributable: MCP server connection status is process-level.",
  },
  {
    id: "memories-detail",
    reason:
      "not project-attributable: fetches a single memory record by id (ctx.query.id), not a list.",
  },
  {
    id: "memories-health",
    reason: "not project-attributable: process-level embeddings-provider health singleton.",
  },
  {
    id: "s3-gauges",
    reason: "not project-attributable: global object-storage usage gauges.",
  },
  {
    id: "slow-topology",
    reason:
      "not project-attributable: daemon hook-inventory / weld-history topology, not project data.",
  },
];

// ---------------------------------------------------------------------------
// Routes — every non-test `.ts` file under `src/cockpit/routes/` not listed
// here must show SCOPE_EVIDENCE_PATTERN in its own source.
//
// Scope-consuming (verified via resolveCockpitProjectScope, mt#2418/mt#4727):
// activity, follow-ups (both mt#4746, documented partial-filter semantics via
// relatedTaskId — see packages/domain/src/events/query.ts's and
// packages/domain/src/scheduler/follow-up-service.ts's docblocks), asks,
// changesets, conversation-search, session-film, tasks.
// ---------------------------------------------------------------------------
export const ROUTE_ALLOWLIST: AllowlistEntry[] = [
  {
    id: "agent-focus",
    reason:
      "not project-attributable: acts on one already-identified agent id (POST /api/agents/:id/focus).",
  },
  {
    id: "agents",
    reason:
      "not project-attributable: single-agent detail/live-tail by id, not a project-wide list.",
  },
  {
    id: "context-inspector",
    reason:
      "not project-attributable: single-conversation snapshot addressed by ?sessionId=, not a list.",
  },
  {
    id: "conversation-presence",
    reason: "not project-attributable: single-conversation presence by id.",
  },
  {
    id: "conversation-rehydrate",
    reason:
      "not project-attributable: rehydration action on one already-identified conversation id.",
  },
  {
    id: "conversation-run-state",
    reason:
      "not project-attributable: single-event ingest write keyed by session id in the body, not a list.",
  },
  {
    id: "conversations",
    reason:
      "not project-attributable: live-tail/overview by :agentSessionId, not a project-wide list.",
  },
  {
    id: "credentials",
    reason: "not project-attributable: credentials are stored globally, not per-project.",
  },
  {
    id: "driven-sessions",
    reason:
      "deferred (list endpoint only): GET /api/driven-session scans an in-memory " +
      "process registry with no project concept; would need a task→project " +
      "resolution per entry. The mutation endpoints (create/attach/stop) act on one " +
      "already-identified session id and are not project-attributable at all. " +
      "Tracked at mt#4746. (Distinct from mt#4319/mt#3274/mt#3325/mt#3363, which own " +
      "this same file for the console/attach/WS-transport feature.)",
  },
  {
    id: "embeddings",
    reason:
      "not project-attributable: embeddings-consumer overview/error/reindex admin operations.",
  },
  {
    id: "engprod-proposals",
    reason:
      "not project-attributable (mt#4727): Minsky's own eng-process tooling, always " +
      "filed against Minsky's own task backend regardless of dashboard selection.",
  },
  {
    id: "entity-threads",
    reason: "not project-attributable: single-entity-thread fetch/reply by :entityType/:entityId.",
  },
  {
    id: "events",
    reason:
      "not project-attributable (mt#4727): SSE broker-wide push channel with no " +
      "per-event project attribution.",
  },
  {
    id: "health",
    reason:
      "not project-attributable: /api/health, /api/widgets, and the widget dispatcher " +
      "itself (/api/widget/:id/data) — daemon metadata, not project data. The " +
      "dispatcher is where req.projectScope is forwarded onto WidgetContext for every " +
      "OTHER widget; it is the mechanism, not a consumer of it.",
  },
  {
    id: "projects",
    reason:
      "not project-attributable: GET /api/projects IS the project selector's own " +
      "data source — it must always return every project, by definition.",
  },
  {
    id: "sweeps",
    reason: "not project-attributable: daemon-wide sweep-liveness registry.",
  },
];

/** Every live, non-test route module under `src/cockpit/routes/`. */
export function listRouteModules(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

/** Every live widget id registered in `WIDGET_REGISTRY`. */
export function listWidgetIds(): string[] {
  return Object.keys(WIDGET_REGISTRY).sort();
}

function readModuleSource(dir: string, moduleId: string): string {
  return String(readFileSync(join(dir, `${moduleId}.ts`), "utf-8"));
}

export function widgetSourceConsumesScope(widgetId: string): boolean {
  return SCOPE_EVIDENCE_PATTERN.test(readModuleSource(WIDGETS_DIR, widgetId));
}

export function routeSourceConsumesScope(moduleName: string): boolean {
  return SCOPE_EVIDENCE_PATTERN.test(readModuleSource(ROUTES_DIR, moduleName));
}

/**
 * Pure classification function, exported so `scope-census.test.ts` can prove
 * the AT1 property ("adding a toy unscoped widget/route trips the check")
 * without writing a real fixture file to disk: pass a synthetic source
 * string and id, and this returns whether the census would consider it
 * decided.
 */
export function isScopeDecided(source: string, id: string, allowlist: AllowlistEntry[]): boolean {
  if (allowlist.some((entry) => entry.id === id)) return true;
  return SCOPE_EVIDENCE_PATTERN.test(source);
}
