/**
 * Session-film routes (mt#3184 — Watchable world Phase 1).
 *
 *   GET /api/cockpit/session-film/events?conversationId=<id>
 *   GET /api/cockpit/session-film/sessions
 *
 * Computed-endpoint pattern (matches `./context-inspector.ts`): no new
 * persistence. The events endpoint fetches a transcript via the
 * `getTranscript()` seam, resolves this transcript's user-turn actor (parent
 * agent if spawned, else principal — RFC Amendment 2), and runs the mt#3157
 * adapter (`adaptTranscriptToEvents`) per-request. The sessions endpoint
 * lists filmable conversations, applying the SAME credential-scrub gate as
 * the Gource exporter (RFC "Data honesty" / MVP section) — a session
 * ingested before the mt#2864 scrub-confirmed cutoff is marked
 * `scrubGateOk: false` and the client refuses to open it (spec SC 1 / AT8)
 * unless the caller explicitly asserts `verifiedRescrubbed`.
 *
 * @see packages/domain/src/transcripts/event-adapter.ts
 * @see packages/domain/src/transcripts/gource-exporter.ts — the scrub-gate precedent
 * @see mt#3157 — Phase 0 (schema + adapter + exporter)
 * @see mt#3184 — this task
 */
import type express from "express";
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { looksLikeConversationId, withBoundedTimeout } from "../conversation-id-space";
import { getContextInspectorDb } from "../db-providers";

// ── Error shape (mirrors context-inspector.ts's discipline) ─────────────────

type SessionFilmErrorCode =
  | "missing_field"
  | "unsupported_provider"
  | "session_not_found"
  | "invalid_id"
  | "unscrubbed"
  | "internal";

function sessionFilmError(
  res: express.Response,
  status: number,
  code: SessionFilmErrorCode,
  message: string
): void {
  res.status(status).json({ error: { code, message } });
}

function logInternal(route: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log.error(`[session-film] ${route} — internal error: ${detail}`);
}

/** Bound for the events-assembly call (mirrors context-inspector.ts's SNAPSHOT_ASSEMBLY_TIMEOUT_MS). */
const EVENTS_ASSEMBLY_TIMEOUT_MS = 15_000;

// ── Public result/row shapes ──────────────────────────────────────────────

export interface SessionFilmEventsResult {
  events: SemanticEvent[];
  /** The stored `agent_transcripts.ingested_at` value, for the client's own scrub-gate display. */
  ingestedAt: string | null;
}

export interface SessionFilmPickerRow {
  agentSessionId: string;
  label: string;
  startedAt: string | null;
  cwd: string | null;
  ingestedAt: string | null;
  /** True when `ingestedAt` is on/after the credential-scrub cutoff (see gource-exporter.ts). */
  scrubGateOk: boolean;
}

// ── Test seams ────────────────────────────────────────────────────────────

export interface SessionFilmRouteOptions {
  /**
   * Test seam: override event fetching entirely (bypasses DB + adapter
   * wiring). Returns `null` for "no such conversation". Production code
   * never sets this — the real implementation is
   * {@link defaultFetchEvents}.
   */
  overrideFetchEvents?: (conversationId: string) => Promise<SessionFilmEventsResult | null>;
  /**
   * Test seam: override the picker's session list. Production code never
   * sets this — the real implementation is {@link defaultListSessions}.
   */
  overrideListSessions?: () => Promise<SessionFilmPickerRow[]>;
}

const MAX_PICKER_SESSIONS = 50;

async function resolveUserTurnActor(
  db: PostgresJsDatabase,
  conversationId: string
): Promise<import("@minsky/domain/transcripts/event-schema").EventActor> {
  const { agentSpawnsTable } = await import("@minsky/domain/storage/schemas/agent-spawns-schema");
  const rows = await db
    .select({ parentAgentSessionId: agentSpawnsTable.parentAgentSessionId })
    .from(agentSpawnsTable)
    .where(eq(agentSpawnsTable.childAgentSessionId, conversationId))
    .limit(1);
  const parent = rows[0]?.parentAgentSessionId;
  return parent ? { kind: "agent", agentSessionId: parent } : { kind: "principal" };
}

async function defaultFetchEvents(conversationId: string): Promise<SessionFilmEventsResult | null> {
  const db = await getContextInspectorDb();
  if (!db) return null;

  const { AgentTranscriptService } = await import("@minsky/domain/provenance/transcript-service");
  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { adaptTranscriptToEvents, extractLeadingUserTexts } = await import(
    "@minsky/domain/transcripts/event-adapter"
  );
  const { computeConversationLabel, pickSubstantiveUserText } = await import(
    "@minsky/domain/transcripts/conversation-label"
  );

  const service = new AgentTranscriptService(db);
  const transcript = await service.getTranscript(conversationId as never);
  if (!transcript) return null;

  const rows = await db
    .select({
      ingestedAt: agentTranscriptsTable.ingestedAt,
      cwd: agentTranscriptsTable.cwd,
      startedAt: agentTranscriptsTable.startedAt,
    })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, conversationId as never))
    .limit(1);
  const row = rows[0];

  const agentDisplayLabel = computeConversationLabel({
    agentSessionId: conversationId,
    cwd: row?.cwd ?? null,
    startedAt: row?.startedAt ?? null,
    linkedTaskTitle: null,
    firstUserText: pickSubstantiveUserText(extractLeadingUserTexts(transcript)),
    subagentDescriptor: null,
  });

  const userTurnActor = await resolveUserTurnActor(db, conversationId);
  const events = adaptTranscriptToEvents(transcript, {
    agentSessionId: conversationId,
    userTurnActor,
    agentDisplayLabel,
  });

  return {
    events,
    ingestedAt: row?.ingestedAt ? new Date(row.ingestedAt).toISOString() : null,
  };
}

async function defaultListSessions(): Promise<SessionFilmPickerRow[]> {
  const db = await getContextInspectorDb();
  if (!db) return [];

  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { isNotNull } = await import("drizzle-orm");
  const { CREDENTIAL_SCRUB_CUTOFF_ISO } = await import(
    "@minsky/domain/transcripts/gource-exporter"
  );
  const { deriveFallbackLabel } = await import("@minsky/domain/transcripts/conversation-label");

  const rows = await db
    .select({
      agentSessionId: agentTranscriptsTable.agentSessionId,
      startedAt: agentTranscriptsTable.startedAt,
      cwd: agentTranscriptsTable.cwd,
      ingestedAt: agentTranscriptsTable.ingestedAt,
    })
    .from(agentTranscriptsTable)
    .where(and(isNotNull(agentTranscriptsTable.agentSessionId)))
    .orderBy(desc(agentTranscriptsTable.startedAt))
    .limit(MAX_PICKER_SESSIONS);

  const cutoff = new Date(CREDENTIAL_SCRUB_CUTOFF_ISO).getTime();

  return rows.map((r) => {
    const startedAt = r.startedAt ? new Date(r.startedAt) : null;
    const ingestedAt = r.ingestedAt ? new Date(r.ingestedAt) : null;
    return {
      agentSessionId: r.agentSessionId,
      label: deriveFallbackLabel(r.agentSessionId, r.cwd ?? null, startedAt),
      startedAt: startedAt ? startedAt.toISOString() : null,
      cwd: r.cwd ?? null,
      ingestedAt: ingestedAt ? ingestedAt.toISOString() : null,
      scrubGateOk: ingestedAt !== null && ingestedAt.getTime() >= cutoff,
    };
  });
}

/** Mount /api/cockpit/session-film/* on `app`. */
export function mountSessionFilmRoutes(
  app: express.Express,
  opts: SessionFilmRouteOptions = {}
): void {
  const fetchEvents = opts.overrideFetchEvents ?? defaultFetchEvents;
  const listSessions = opts.overrideListSessions ?? defaultListSessions;

  /**
   * GET /api/cockpit/session-film/sessions — picker source: filmable
   * conversations, newest first, each carrying `scrubGateOk` so the client
   * can refuse a pre-cutoff un-re-scrubbed session (spec SC 1 / AT8).
   */
  app.get("/api/cockpit/session-film/sessions", async (_req, res) => {
    try {
      const sessions = await withBoundedTimeout(listSessions(), EVENTS_ASSEMBLY_TIMEOUT_MS);
      res.json({ sessions });
    } catch (err) {
      logInternal("GET /api/cockpit/session-film/sessions", err);
      sessionFilmError(res, 500, "internal", "An internal error occurred while listing sessions.");
    }
  });

  /**
   * GET /api/cockpit/session-film/events?conversationId=<id>&verifiedRescrubbed=<bool>
   *
   * Returns the ordered `SemanticEvent[]` for a conversation. Refuses (422
   * `unscrubbed`) a session ingested before the credential-scrub cutover
   * unless `verifiedRescrubbed=true` is passed — the SAME gate the picker
   * enforces client-side, re-checked server-side so a directly-typed `?t=`
   * deep link can't bypass it.
   */
  app.get("/api/cockpit/session-film/events", async (req, res) => {
    const conversationId = req.query["conversationId"];
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      sessionFilmError(res, 400, "missing_field", "`conversationId` is required.");
      return;
    }
    if (!looksLikeConversationId(conversationId)) {
      sessionFilmError(
        res,
        404,
        "invalid_id",
        `"${conversationId}" is not a valid conversation id.`
      );
      return;
    }

    const verifiedRescrubbed = req.query["verifiedRescrubbed"] === "true";

    try {
      const result = await withBoundedTimeout(
        fetchEvents(conversationId),
        EVENTS_ASSEMBLY_TIMEOUT_MS
      );
      if (result === null) {
        sessionFilmError(
          res,
          404,
          "session_not_found",
          "No transcript found for the requested session."
        );
        return;
      }

      const { assertScrubGate, UnscrubbedSessionError } = await import(
        "@minsky/domain/transcripts/gource-exporter"
      );
      try {
        assertScrubGate(result.ingestedAt, verifiedRescrubbed);
      } catch (err) {
        if (err instanceof UnscrubbedSessionError) {
          sessionFilmError(res, 422, "unscrubbed", err.message);
          return;
        }
        throw err;
      }

      res.json({ events: result.events, ingestedAt: result.ingestedAt });
    } catch (err) {
      logInternal("GET /api/cockpit/session-film/events", err);
      sessionFilmError(
        res,
        500,
        "internal",
        "An internal error occurred while assembling the session film."
      );
    }
  });
}
