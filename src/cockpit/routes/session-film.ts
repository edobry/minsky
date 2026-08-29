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
 * lists filmable conversations.
 *
 * These endpoints are UNGATED by the credential-scrub gate, by decision
 * (ADR-040, mt#3268): the gate binds where transcript bytes CROSS the
 * operator's trust boundary — a file export, an anonymous share link — not
 * where the operator reads their own stored history behind their own
 * authentication. Until mt#3268 the film applied the gate while
 * `routes/context-inspector.ts` did not, so a pre-cutoff conversation was
 * unwatchable as a film and fully readable in the conversation view one
 * route over. Do not re-add a gate here without revisiting ADR-040.
 *
 * @see packages/domain/src/transcripts/event-adapter.ts
 * @see docs/architecture/adr-040-transcript-scrub-gate-binds-at-trust-boundary-crossings.md
 * @see mt#3157 — Phase 0 (schema + adapter + exporter)
 * @see mt#3184 — this task
 */
import type express from "express";
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { looksLikeConversationId, withBoundedTimeout } from "../conversation-id-space";
import { getContextInspectorDb } from "../db-providers";

// ── Error shape (mirrors context-inspector.ts's discipline) ─────────────────

type SessionFilmErrorCode =
  | "missing_field"
  | "unsupported_provider"
  | "session_not_found"
  | "invalid_id"
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

/**
 * Stable-sort events by `tStart` ascending, at the serving boundary (mt#3188).
 *
 * The endpoint's contract documents an ordered `SemanticEvent[]`, but the
 * adapter's emission order is transcript-line order (mt#3157), which can
 * contain small inversions (e.g. an `ask`-verb event carrying a sub-line
 * timestamp from the ask record). `Array.prototype.sort` is spec-guaranteed
 * stable (ES2019+), so events sharing an exact `tStart` — i.e. members of the
 * same parallel batch, see `batchId` — keep their original relative
 * (emission) order; no intra-batch order is invented. This is deliberately
 * the ONLY place ordering is enforced: adapter pairing and batch semantics
 * are untouched.
 */
function stableSortByTStart(events: SemanticEvent[]): SemanticEvent[] {
  return [...events].sort((a, b) => Date.parse(a.tStart) - Date.parse(b.tStart));
}

/** Bound for the events-assembly call (mirrors context-inspector.ts's SNAPSHOT_ASSEMBLY_TIMEOUT_MS). */
const EVENTS_ASSEMBLY_TIMEOUT_MS = 15_000;

// ── Public result/row shapes ──────────────────────────────────────────────

export interface SessionFilmEventsResult {
  events: SemanticEvent[];
  /** The stored `agent_transcripts.ingested_at` value, for the client's own scrub-gate display. */
  ingestedAt: string | null;
}

/**
 * The film-owned content result (mt#3262 SC 5): the transcript's turn lines,
 * converted to `SessionContextSnapshotBlock[]` via the SAME `turnLineToBlock`
 * conversion `assembleSessionContextSnapshot` applies — one whole-transcript
 * fetch per conversation (not per-row). The client indexes this array by
 * `turnIndex` to resolve an event's `sourceRef` to its real content.
 */
export interface SessionFilmContentResult {
  blocks: SessionContextSnapshotBlock[];
  /** The stored `agent_transcripts.ingested_at` value — same field the events result carries. */
  ingestedAt: string | null;
}

export interface SessionFilmPickerRow {
  agentSessionId: string;
  label: string;
  startedAt: string | null;
  cwd: string | null;
  ingestedAt: string | null;
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
  /**
   * Test seam: override the content fetch entirely (bypasses DB + snapshot
   * conversion). Returns `null` for "no such conversation". Production code
   * never sets this — the real implementation is {@link fetchConversationBlocks}.
   */
  overrideFetchContent?: (conversationId: string) => Promise<SessionFilmContentResult | null>;
}

const MAX_PICKER_SESSIONS = 50;

/**
 * Filters picker rows down to those whose `agentSessionId` is admissible
 * under the SAME `looksLikeConversationId` predicate the events endpoint
 * enforces (mt#3225 SC3/AT3) — the picker and the events endpoint must never
 * again disagree about which ids are valid conversation ids. This is also
 * what drops a non-conversation row (e.g. a diagnostic probe row written
 * directly to `agent_transcripts` outside normal ingest) from the picker —
 * one shared predicate, not a second ad-hoc filter that could drift from it.
 *
 * Exported (rather than inlined in {@link defaultListSessions}) so it can be
 * unit-tested against fixture rows spanning all observed id classes without
 * a live DB connection.
 */
export function filterAdmissiblePickerRows<T extends { agentSessionId: string }>(
  rows: readonly T[]
): T[] {
  return rows.filter((r) => looksLikeConversationId(r.agentSessionId));
}

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

/**
 * Film-owned content fetch (mt#3262 SC 2/SC 5): the SAME `getTranscript()`
 * seam `defaultFetchEvents` above uses, converted to
 * `SessionContextSnapshotBlock[]` via `turnLineToBlock` — the SAME per-index
 * conversion `assembleSessionContextSnapshot` applies over the SAME array
 * (session-context-snapshot.ts). One whole-transcript fetch, not a per-row
 * round-trip; the caller indexes the returned `blocks` by `turnIndex`.
 *
 * Deliberately does NOT route through `/api/cockpit/context-inspector/snapshot`
 * (`context-inspector.ts`) — that route applies no scrub gate, so piggybacking
 * it would let film content bypass the credential-scrub cutoff the events
 * endpoint below already enforces. See the module doc comment.
 */
export async function fetchConversationBlocks(
  conversationId: string
): Promise<SessionFilmContentResult | null> {
  const db = await getContextInspectorDb();
  if (!db) return null;

  const { AgentTranscriptService } = await import("@minsky/domain/provenance/transcript-service");
  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { turnLineToBlock } = await import("@minsky/domain/transcripts/session-context-snapshot");

  const service = new AgentTranscriptService(db);
  const transcript = await service.getTranscript(conversationId as never);
  if (!transcript) return null;

  const rows = await db
    .select({ ingestedAt: agentTranscriptsTable.ingestedAt })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, conversationId as never))
    .limit(1);
  const row = rows[0];

  const blocks: SessionContextSnapshotBlock[] = [];
  transcript.forEach((entry, idx) => {
    const block = turnLineToBlock(conversationId, idx, entry);
    if (block !== null) blocks.push(block);
  });

  return {
    blocks,
    ingestedAt: row?.ingestedAt ? new Date(row.ingestedAt).toISOString() : null,
  };
}

/**
 * Deliberately NOT project-scoped (mt#4727). This picker queries
 * `agentTranscriptsTable` directly — the same substrate
 * `TranscriptListService.listConversations` reads, whose docblock records
 * the verified mt#2818 R1 decision that the whole transcripts_* subsystem
 * stays outside ADR-021's five scoped operations (`tasks.list`,
 * `session.list`, `memory.list`, `memory.search`, `asks.list`). A harness
 * conversation is not reliably attributable to one Minsky project, and
 * scoping this picker alone would leave it inconsistent with
 * `routes/conversation-search.ts` and the other transcripts_* readers. See
 * this task's spec `## Outcome` for the recorded decision.
 */
async function defaultListSessions(): Promise<SessionFilmPickerRow[]> {
  const db = await getContextInspectorDb();
  if (!db) return [];

  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { isNotNull } = await import("drizzle-orm");
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

  return filterAdmissiblePickerRows(rows).map((r) => {
    const startedAt = r.startedAt ? new Date(r.startedAt) : null;
    const ingestedAt = r.ingestedAt ? new Date(r.ingestedAt) : null;
    return {
      agentSessionId: r.agentSessionId,
      label: deriveFallbackLabel(r.agentSessionId, r.cwd ?? null, startedAt),
      startedAt: startedAt ? startedAt.toISOString() : null,
      cwd: r.cwd ?? null,
      ingestedAt: ingestedAt ? ingestedAt.toISOString() : null,
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
  const fetchContent = opts.overrideFetchContent ?? fetchConversationBlocks;

  /**
   * GET /api/cockpit/session-film/sessions — picker source: filmable
   * conversations, newest first.
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
   * GET /api/cockpit/session-film/events?conversationId=<id>
   *
   * Returns the ordered `SemanticEvent[]` for a conversation. Ungated by the
   * credential-scrub gate — see the module doc comment and ADR-040.
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

      res.json({ events: stableSortByTStart(result.events), ingestedAt: result.ingestedAt });
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

  /**
   * GET /api/cockpit/session-film/content?conversationId=<id>
   *
   * mt#3262 SC 2/SC 5 — the film-owned content endpoint an expanded ribbon
   * row fetches on first expand: the transcript's turn lines, converted to
   * `SessionContextSnapshotBlock[]`, so the client can resolve an event's
   * `sourceRef.turnIndex` to real content and render it via the shared
   * `ElementView` renderers. Kept separate from
   * `/api/cockpit/context-inspector/snapshot` because the film owns this
   * shape and its fetch granularity, NOT because the two differ on the
   * credential-scrub gate — as of ADR-040 neither is gated.
   */
  app.get("/api/cockpit/session-film/content", async (req, res) => {
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

    try {
      const result = await withBoundedTimeout(
        fetchContent(conversationId),
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

      res.json({ blocks: result.blocks, ingestedAt: result.ingestedAt });
    } catch (err) {
      logInternal("GET /api/cockpit/session-film/content", err);
      sessionFilmError(
        res,
        500,
        "internal",
        "An internal error occurred while assembling the session film content."
      );
    }
  });
}
