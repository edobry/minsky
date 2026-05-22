/**
 * Context-inspector widget (mt#2023)
 *
 * Exposes the list of known agent sessions for the cockpit "Context" tab.
 * Per-session detail (the full `SessionContextSnapshot`) is fetched via the
 * separate endpoint `/api/cockpit/context-inspector/snapshot?sessionId=...`
 * registered in `cockpit/server.ts` — the widget framework's single-payload
 * shape doesn't fit the interactive picker → detail pattern, so the snapshot
 * lives as a sibling endpoint.
 *
 * The widget itself returns the session-picker source: the top-50 known
 * sessions from the `agent_transcripts` table, start-time-ordered, with a
 * brief summary suitable for a dropdown label. Self-fetching via TanStack
 * Query on the React side — no app-level polling.
 *
 * @see mt#2023 — this widget
 * @see mt#2022 — substrate that makes the snapshot endpoint possible
 * @see mt#2033 — canonical SessionContextSnapshot shape returned by the endpoint
 * @see mt#2021 — cockpit context-inspector umbrella
 */

import { desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../../domain/storage/schemas/agent-transcripts-schema";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";

/** Shape of a single session-picker row */
export interface ContextInspectorSessionRow {
  agentSessionId: string;
  harness: string;
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  /** Brief label suitable for dropdown text — derived from cwd + agentSessionId */
  label: string;
}

/** Full payload returned by this widget when state === "ok" */
export interface ContextInspectorPayload {
  sessions: ContextInspectorSessionRow[];
}

/** Max sessions returned to keep the dropdown sane */
const MAX_SESSIONS = 50;

/** Build a brief human-readable label for the dropdown. */
function deriveLabel(agentSessionId: string, cwd: string | null, startedAt: Date | null): string {
  const sessionPrefix = agentSessionId.slice(0, 8);
  const cwdSuffix = cwd ? cwd.split("/").slice(-2).join("/") : "unknown";
  const ts = startedAt ? startedAt.toISOString().slice(0, 16).replace("T", " ") : "no-ts";
  return `${ts} · ${cwdSuffix} · ${sessionPrefix}`;
}

/**
 * Factory: returns the widget backed by the given DB factory. Tests inject a
 * mocked db; production wires the canonical Postgres connection.
 */
export function createContextInspectorWidget(
  getDb: () => Promise<PostgresJsDatabase>
): WidgetModule {
  return {
    id: "context-inspector",
    title: "Context",
    updateMode: { type: "polling", intervalMs: 15000 },
    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const db = await getDb();
        const rows = await db
          .select({
            agentSessionId: agentTranscriptsTable.agentSessionId,
            harness: agentTranscriptsTable.harness,
            startedAt: agentTranscriptsTable.startedAt,
            endedAt: agentTranscriptsTable.endedAt,
            cwd: agentTranscriptsTable.cwd,
          })
          .from(agentTranscriptsTable)
          .orderBy(desc(agentTranscriptsTable.startedAt))
          .limit(MAX_SESSIONS);

        const sessions: ContextInspectorSessionRow[] = rows.map((r) => ({
          agentSessionId: r.agentSessionId,
          harness: r.harness,
          startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : null,
          endedAt: r.endedAt instanceof Date ? r.endedAt.toISOString() : null,
          cwd: r.cwd,
          label: deriveLabel(r.agentSessionId, r.cwd, r.startedAt),
        }));

        const payload: ContextInspectorPayload = { sessions };
        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `context-inspector error: ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget
//
// Mirrors the agents.ts singleton pattern: lazy PersistenceService init, no DI
// container. The cockpit server doesn't have one and constructing a singleton
// here is the established pattern.
// ---------------------------------------------------------------------------

let _cachedDb: PostgresJsDatabase | null = null;

async function defaultDbFactory(): Promise<PostgresJsDatabase> {
  if (_cachedDb) return _cachedDb;

  const { PersistenceService } = await import("../../domain/persistence/service");
  const svc = new PersistenceService();
  await svc.initialize();
  const provider = svc.getProvider();

  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
  ) {
    throw new Error("context-inspector requires a SQL persistence provider");
  }

  const sqlProvider = provider as {
    getDatabaseConnection: () => Promise<PostgresJsDatabase>;
  };
  _cachedDb = await sqlProvider.getDatabaseConnection();
  return _cachedDb;
}

/** Default context-inspector widget — drop into WIDGET_REGISTRY */
export const contextInspectorWidget: WidgetModule = createContextInspectorWidget(defaultDbFactory);
