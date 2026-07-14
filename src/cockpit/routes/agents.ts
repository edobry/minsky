/**
 * Cockpit agent (workspace-session) routes (mt#2615 — extracted from
 * server.ts, mt#1919 / mt#2232).
 *
 *   GET /api/agents/:id            — workspace-session detail (mt#1919)
 *   GET /api/agents/:id/live-tail  — Rung-1 live-tail SSE stream (mt#2232)
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import { getServerSessionProvider, getContextInspectorDb } from "../db-providers";

/**
 * Resolve every `minsky_session_links` candidate for a workspace session
 * (mt#2441 + mt#2756 + mt#2768). Link-CLASS AGNOSTIC (no filter on
 * link_type) — picks up BOTH the cwd_match class (written at ingest time by
 * AgentTranscriptIngestService, backfilled via
 * scripts/backfill-minsky-session-links.ts) AND the subagent_spawn class
 * (written by AgentSpawnsPipeline from spawn provenance, backfilled via
 * scripts/backfill-subagent-spawn-links.ts). The subagent_spawn class is what
 * resolves a DISPATCHED subagent's workspace — its transcript's own cwd never
 * matches the workspace directory (mt#2749 finding: subagents don't chdir),
 * so cwd_match alone misses it.
 *
 * NO cwd LIKE fallback (mt#2768 — deleted): the substrate prerequisites
 * (mt#2441, mt#2756) have landed and backfilled, so link rows are the sole
 * resolution mechanism now. A conversation with no link row is reported as
 * unresolved rather than falling back to a live heuristic query.
 *
 * @returns every candidate row, newest-`startedAt`-first — the run-detail
 *   page's conversation switcher (mt#2768 Behavior: "multi-conversation
 *   workspaces") needs the FULL set, not just the best one. `confidence` is
 *   retained (not just exposed via the response) so the caller can still
 *   feed the FULL candidate set into `pickBestConversationLink` for the
 *   back-compat singular `conversation` field.
 */
async function resolveWorkspaceConversations(minskySessionId: string): Promise<
  Array<{
    agentSessionId: string;
    confidence: number | null;
    startedAt: string | null;
  }>
> {
  try {
    const db = await getContextInspectorDb();
    if (!db) return [];
    const { agentTranscriptsTable } = await import(
      "@minsky/domain/storage/schemas/agent-transcripts-schema"
    );
    const { minskySessionLinksTable } = await import(
      "@minsky/domain/storage/schemas/minsky-session-links-schema"
    );
    const { eq, desc, sql } = await import("drizzle-orm");

    const linkRows = await db
      .select({
        agentSessionId: minskySessionLinksTable.agentSessionId,
        confidence: minskySessionLinksTable.confidence,
        startedAt: agentTranscriptsTable.startedAt,
      })
      .from(minskySessionLinksTable)
      .innerJoin(
        agentTranscriptsTable,
        eq(agentTranscriptsTable.agentSessionId, minskySessionLinksTable.agentSessionId)
      )
      .where(eq(minskySessionLinksTable.minskySessionId, minskySessionId))
      .orderBy(sql`${desc(agentTranscriptsTable.startedAt)} NULLS LAST`);

    return linkRows.map((r) => ({
      agentSessionId: r.agentSessionId,
      confidence: r.confidence,
      startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : null,
    }));
  } catch (convErr) {
    const msg = convErr instanceof Error ? convErr.message : String(convErr);
    log.debug(`[agents] conversation enrichment degraded: ${msg}`);
    return [];
  }
}

/** Mount /api/agents/:id and /api/agents/:id/live-tail on `app`. */
export function mountAgentRoutes(app: express.Express): void {
  /**
   * GET /api/agents/:id — workspace-session detail for the drill-down page
   * (mt#1919). Keyed by the MINSKY workspace sessionId (not the harness
   * agentSessionId — see src/cockpit/session-detail.ts header).
   *
   * Returns: { session, commits, pr, conversation, conversations }
   *   - `conversation` — the single BEST link (back-compat; kept for callers
   *     that just want "the" conversation).
   *   - `conversations` — every resolved link, newest-first (mt#2768 —
   *     drives the run-detail Conversation-tab switcher for multi-conversation
   *     workspaces).
   * Every enrichment (git log, task title, transcript resolution) degrades
   * independently — only a missing session record is a 404.
   */
  app.get("/api/agents/:id", async (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      res.status(400).json({ error: "Session ID required" });
      return;
    }
    const sessionId = decodeURIComponent(rawId);

    try {
      const provider = await getServerSessionProvider();
      if (!provider) {
        res.status(503).json({
          error: "Session service unavailable — persistence provider not ready",
        });
        return;
      }

      const record = await provider.getSession(sessionId);
      if (!record) {
        res.status(404).json({ error: `Session ${sessionId} not found` });
        return;
      }

      // Workspace dir: record fields first, provider lookup as fallback.
      let workdir: string | null = record.workspacePath ?? record.sessionPath ?? null;
      if (!workdir) {
        try {
          workdir = await provider.getSessionWorkdir(sessionId);
        } catch {
          workdir = null;
        }
      }

      const { buildWorkspaceOverview } = await import("../workspace-overview");
      const overviewPromise = buildWorkspaceOverview(record, workdir);
      const conversationsPromise = resolveWorkspaceConversations(sessionId);

      const [{ session, commits, pr }, conversations] = await Promise.all([
        overviewPromise,
        conversationsPromise,
      ]);

      const { pickBestConversationLink } = await import("../session-detail");
      const conversation = pickBestConversationLink(conversations);

      res.json({
        session,
        commits,
        pr,
        conversation,
        conversations: conversations.map((c) => ({
          agentSessionId: c.agentSessionId,
          startedAt: c.startedAt,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[agents] GET /api/agents/:id — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while fetching the session." });
    }
  });

  /**
   * GET /api/agents/:id/live-tail — Rung-1 live-tail SSE stream (mt#2232).
   *
   * Streams new transcript turns as they are appended to the Claude Code JSONL
   * file for the given workspace session. Each SSE `data:` payload is a
   * `SessionContextSnapshotBlock` (JSON) so the SPA can append them to the
   * existing snapshot without re-fetching.
   *
   * Id-space: `:id` is the MINSKY workspace sessionId — the same id-space as
   * `/api/agents/:id`. The endpoint resolves workspace→agentSessionId via the
   * `agent_transcripts` table (same query as the parent endpoint), then locates
   * the JSONL file under `~/.claude/projects/`.
   *
   * The stream seeds the tailer at the current EOF so only FUTURE appends are
   * sent; historical turns come from the snapshot endpoint (ConversationFetcher).
   *
   * Returns:
   *   - 200 + `text/event-stream` on success
   *   - 404 when the workspace session or JSONL file is not found
   *   - 503 when a required service is unavailable
   *
   * @see src/cockpit/live-tail-poller.ts — JsonlTailer + block-conversion helpers
   * @see mt#2232 — Rung-1 observe→drive ladder
   */
  app.get("/api/agents/:id/live-tail", async (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      res.status(400).json({ error: "Session ID required" });
      return;
    }
    const workspaceSessionId = decodeURIComponent(rawId);

    try {
      // 1. Resolve workspace session → workdir (same pattern as /api/agents/:id)
      const provider = await getServerSessionProvider();
      if (!provider) {
        res.status(503).json({
          error: "Session service unavailable — persistence provider not ready",
        });
        return;
      }

      const record = await provider.getSession(workspaceSessionId);
      if (!record) {
        res.status(404).json({ error: `Session ${workspaceSessionId} not found` });
        return;
      }

      // 2. Resolve agentSessionId via the join (mt#2768 — "workspace-keyed
      //    resolution via the join" success criterion). No cwd LIKE fallback:
      //    a workspace with no link row is reported unresolved rather than
      //    falling back to a live cwd heuristic query.
      const db = await getContextInspectorDb();
      if (!db) {
        res.status(503).json({
          error: "DB unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const { pickBestConversationLink } = await import("../session-detail");
      const candidates = await resolveWorkspaceConversations(workspaceSessionId);
      const linked = pickBestConversationLink(candidates);
      if (!linked) {
        res.status(404).json({
          error: "No transcript found for this session — may not have started yet",
        });
        return;
      }

      // Mint at the boundary: pickBestConversationLink's return is plain
      // string, but the transcripts table column is branded ConversationId.
      const { agentSessionId: agentSessionIdRaw } = linked;
      const agentSessionId = agentSessionIdRaw as import("@minsky/domain/ids").ConversationId;

      // 2b. projectDir is a JSONL-locate optimization only (resolveJsonlPath
      //     falls back to a directory scan when absent) — a single-row lookup
      //     by the now-resolved agentSessionId, not part of the join itself.
      const { agentTranscriptsTable } = await import(
        "@minsky/domain/storage/schemas/agent-transcripts-schema"
      );
      const { eq } = await import("drizzle-orm");
      const projectDirRows = await db
        .select({ projectDir: agentTranscriptsTable.projectDir })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
        .limit(1);
      const projectDir = projectDirRows[0]?.projectDir ?? null;

      // 3. Locate the JSONL file on disk
      const { resolveJsonlPath, startLiveTail } = await import("../live-tail-poller");
      const jsonlPath = await resolveJsonlPath(agentSessionId, { projectDir });
      if (!jsonlPath) {
        res.status(404).json({
          error:
            "JSONL transcript file not found on disk — session may not have written any turns yet",
        });
        return;
      }

      // 4. Set SSE response headers and start streaming
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      let closed = false;

      // Helper — write one SSE data frame (no broker, direct write)
      function sendBlock(
        block: import("@minsky/domain/context/types").SessionContextSnapshotBlock
      ): void {
        if (closed) return;
        res.write(`data: ${JSON.stringify(block)}\n\n`);
      }

      // 5. Start the polling loop (seeds tailer to current EOF)
      const stopTail = await startLiveTail(jsonlPath, agentSessionId, sendBlock);

      // Heartbeat to prevent proxy timeout
      const heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": keep-alive\n\n");
      }, 30_000);

      // Cleanup on client disconnect
      req.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        stopTail();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[agents] GET /api/agents/:id/live-tail — internal error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "An internal error occurred while starting live tail." });
      }
    }
  });
}
