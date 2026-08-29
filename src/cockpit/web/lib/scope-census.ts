/**
 * Frontend structural-enforcement census (mt#4730) — mirrors
 * `src/cockpit/scope-census.ts` on the server side.
 *
 * Enumerates every LIVE frontend source file that makes a raw `fetch()` call
 * to a literal `/api/...` path, and requires each to show one of three kinds
 * of evidence that a scoping decision was made, or carry an allowlist entry
 * with a reason:
 *
 *   1. Imports `api-client.ts` (`apiFetch`/`apiFetchJson`) — the mt#4730
 *      default-appending mechanism. Preferred for any NEW fetch site.
 *   2. Calls `useProject()` — the pre-existing mt#2418/mt#4731 opt-in
 *      pattern (`...useProject().queryParam`). Existing call sites that
 *      already thread this are not required to migrate onto `apiFetch` (the
 *      two are equivalent in effect once threaded; see
 *      `src/cockpit/scope-census.ts`'s docblock for the identical rationale
 *      on the server side).
 *   3. Carries a `deliberately-global` / `deliberately global` marker
 *      comment — the convention mt#4731 already used (`HomePage.tsx`,
 *      `use-entity-index.ts`) to record an intentional non-scoping decision
 *      inline, at the site, rather than only in a census file far away.
 *
 * Evidence is checked at FILE granularity, not per call site — same as the
 * server census. A file with several fetch calls where at least one shows
 * evidence is treated as decided; this mirrors "a module made a scoping
 * decision" rather than auditing every individual call.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo"]);

export interface AllowlistEntry {
  /** Path relative to `src/cockpit/web/`, e.g. `"hooks/useSystemHealth.ts"`. */
  path: string;
  reason: string;
}

const RAW_API_FETCH_PATTERN = /fetch\(\s*[`'"]\/api\//;
const IMPORT_EVIDENCE_PATTERN = /from\s+["']\.{1,2}(\/lib)?\/api-client["']/;
const USE_PROJECT_EVIDENCE_PATTERN = /useProject\s*\(/;
const DELIBERATE_MARKER_PATTERN = /deliberately[- ]global/i;

/**
 * Deliberately-global frontend fetch sites (mt#4730). Reasons mirror the
 * server-side classification of the corresponding route/widget wherever one
 * exists — see `src/cockpit/scope-census.ts` for the backend counterpart.
 */
export const FRONTEND_SCOPE_ALLOWLIST: AllowlistEntry[] = [
  {
    path: "AuthGate.tsx",
    reason:
      "not project-attributable: auth bootstrap (passkey/session status), runs before any project is even selectable.",
  },
  {
    path: "components/Rail.tsx",
    reason: "not project-attributable: fetches GET /api/health, daemon-level status.",
  },
  {
    path: "hooks/useActiveConversationSessions.ts",
    reason: "not project-attributable: fetches GET /api/health, daemon-level status.",
  },
  {
    path: "hooks/useConversationAddress.ts",
    reason: "not project-attributable: resolves one already-identified conversation address by id.",
  },
  {
    path: "hooks/useEventFrequency.ts",
    reason:
      "deferred: fetches GET /api/activity (same endpoint as routes/activity.ts, " +
      "server-side allowlisted as deferred — no projectId column on system_events). " +
      "Tracked at mt#4746.",
  },
  {
    path: "hooks/useConversationPresence.ts",
    reason:
      "not project-attributable: single-conversation presence by id (mirrors routes/conversation-presence.ts).",
  },
  {
    path: "hooks/useFocusAttachment.ts",
    reason:
      "not project-attributable: acts on one already-identified agent id (mirrors routes/agent-focus.ts).",
  },
  {
    path: "hooks/useStartDrivenSession.ts",
    reason:
      "not project-attributable: creates/acts on one driven session by id, not a project-wide list.",
  },
  {
    path: "hooks/useSystemHealth.ts",
    reason: "not project-attributable: daemon process health.",
  },
  {
    path: "lib/conversation-snapshot.ts",
    reason:
      "not project-attributable: fetches the context-inspector snapshot for one " +
      "already-identified sessionId (mirrors routes/context-inspector.ts), not a list.",
  },
  {
    path: "lib/credentials-api.ts",
    reason:
      "not project-attributable: credentials are stored globally, not per-project (mirrors routes/credentials.ts).",
  },
  {
    path: "lib/engprod-proposals.ts",
    reason:
      "not project-attributable (mt#4727): Minsky's own eng-process tooling, always " +
      "filed against Minsky's own task backend regardless of dashboard selection.",
  },
  {
    path: "lib/project-context.tsx",
    reason:
      "not project-attributable: fetchProjects() IS the project selector's own data " +
      "source (GET /api/projects) — it must always return every project, by " +
      "definition (mirrors routes/projects.ts).",
  },
  {
    path: "lib/session-film-client.ts",
    reason:
      "not project-attributable: fetches events/content for one already-identified conversationId, not a project-wide list.",
  },
  {
    path: "lib/shares-client.ts",
    reason: "not project-attributable: acts on one already-identified conversation share by id.",
  },
  {
    path: "pages/ChangesetDetailPage.tsx",
    reason: "not project-attributable: single changeset detail by id, not a project-wide list.",
  },
  {
    path: "pages/EmbeddingsPage.tsx",
    reason:
      "not project-attributable: embeddings-consumer overview/admin operations (mirrors routes/embeddings.ts).",
  },
  {
    path: "widgets/AskDetail.tsx",
    reason: "not project-attributable: single ask detail by id, not a project-wide list.",
  },
  {
    path: "widgets/RunDetail.tsx",
    reason:
      "not project-attributable: single driven-session run detail by id, not a project-wide list.",
  },
  {
    path: "widgets/TaskDetail.tsx",
    reason: "not project-attributable: single task detail by id, not a project-wide list.",
  },
];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) {
      out.push(full);
    }
  }
}

/**
 * Every live, non-test `.ts`/`.tsx` file under `src/cockpit/web/` (relative
 * paths from that root) whose source contains a raw `fetch()` call to a
 * literal `/api/...` path.
 */
export function listRawApiFetchFiles(): string[] {
  const all: string[] = [];
  walk(WEB_ROOT, all);
  const matches: string[] = [];
  for (const abs of all) {
    const src = String(readFileSync(abs, "utf-8"));
    if (RAW_API_FETCH_PATTERN.test(src)) {
      matches.push(abs.slice(WEB_ROOT.length + 1));
    }
  }
  return matches.sort();
}

export function fileSourceConsumesScope(relativePath: string): boolean {
  const src = String(readFileSync(join(WEB_ROOT, relativePath), "utf-8"));
  return (
    IMPORT_EVIDENCE_PATTERN.test(src) ||
    USE_PROJECT_EVIDENCE_PATTERN.test(src) ||
    DELIBERATE_MARKER_PATTERN.test(src)
  );
}

/**
 * Pure classification function, exported so `scope-census.test.ts` can prove
 * the AT1 property directly against a synthetic source string — same
 * pattern as the server-side `isScopeDecided`.
 */
export function isScopeDecided(source: string, path: string, allowlist: AllowlistEntry[]): boolean {
  if (allowlist.some((entry) => entry.path === path)) return true;
  return (
    IMPORT_EVIDENCE_PATTERN.test(source) ||
    USE_PROJECT_EVIDENCE_PATTERN.test(source) ||
    DELIBERATE_MARKER_PATTERN.test(source)
  );
}
