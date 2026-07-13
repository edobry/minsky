/**
 * Cockpit conversation-keyed routes (mt#2749 — the conversation-keyed sibling
 * of the workspace-keyed live tail at `src/cockpit/routes/agents.ts`).
 *
 *   GET /api/conversation/:agentSessionId/live-tail — conversation-keyed live-tail SSE stream
 *
 * The workspace-keyed live tail (`GET /api/agents/:id/live-tail`, mt#2232) needs
 * a workspace→workdir→agentSessionId bridge via an `agent_transcripts` cwd
 * LIKE-match, which resolves for ZERO of the dominant fleet shape (dispatched
 * subagents touch workspaces via absolute paths, not chdir; the principal's own
 * iTerm sessions run in the main repo and were never workspace sessions at all
 * — see mt#2749 spec Context). This endpoint SKIPS that bridge entirely: the
 * JSONL transcript file is keyed directly by the harness `agentSessionId`, so
 * any in-flight conversation can be tailed with no workspace concept at all.
 *
 * The `agent_transcripts` DB lookup here is an OPTIONAL fast-path for
 * `projectDir` only (`resolveJsonlPath` falls back to a directory scan when
 * it's absent or the DB is unavailable) — unlike the workspace-keyed sibling,
 * a DB outage does NOT 503 this endpoint, and there is NO cwd LIKE query.
 *
 * @see src/cockpit/routes/agents.ts — the workspace-keyed sibling (steps 3-5
 *   of its live-tail handler are mirrored here verbatim)
 * @see src/cockpit/live-tail-poller.ts — resolveJsonlPath + startLiveTail
 * @see mt#2749 — this endpoint
 * @see mt#2232 — Rung-1 observe→drive ladder (workspace-keyed precursor)
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import { getContextInspectorDb } from "../db-providers";
import type { ConversationId } from "@minsky/domain/ids";
import type { ResolveJsonlFsMod, StatFn, TailerLike } from "../live-tail-poller";

/**
 * Options accepted by {@link mountConversationRoutes}. Every field here is a
 * test-only injection seam (mirrors the `no-real-fs-in-tests` DI convention
 * already used by `live-tail-poller.test.ts`) — production never sets any of
 * these; `resolveJsonlPath`/`startLiveTail` fall back to their real-fs/real-
 * timer defaults when omitted.
 */
export interface ConversationRoutesOptions {
  /**
   * Override for the Claude Code projects directory root. Passed through to
   * `resolveJsonlPath`'s `claudeProjectsDir` option so tests can point the
   * scan at a hermetic path instead of the real `~/.claude/projects/`.
   */
  claudeProjectsDirOverride?: string;
  /** Override the fs abstraction `resolveJsonlPath` uses for its directory scan. */
  fsMod?: ResolveJsonlFsMod;
  /** Override the `TailerLike` instance `startLiveTail` polls (avoids real disk reads). */
  tailer?: TailerLike;
  /** Override the stat function `startLiveTail` uses to seed the tailer offset. */
  statFn?: StatFn;
  /** Override the poll interval (ms) `startLiveTail` uses (tests use a short window). */
  pollMs?: number;
}

/** Mount /api/conversation/:agentSessionId/live-tail on `app`. */
export function mountConversationRoutes(
  app: express.Express,
  opts: ConversationRoutesOptions = {}
): void {
  const { claudeProjectsDirOverride, fsMod, tailer, statFn, pollMs } = opts;

  /**
   * GET /api/conversation/:agentSessionId/live-tail — conversation-keyed
   * live-tail SSE stream (mt#2749).
   *
   * Id-space: `:agentSessionId` is the harness `ConversationId` — NOT a
   * Minsky workspace sessionId. No workspace/session-provider lookup occurs
   * anywhere in this handler.
   *
   * Returns:
   *   - 200 + `text/event-stream` on success
   *   - 400 when the path param is missing
   *   - 404 when the JSONL transcript file is not found on disk (conversation
   *     may not have written any turns yet, or never existed)
   *
   * Never returns 503 — the only DB use is the optional `projectDir`
   * fast-path below, wrapped so a DB outage silently falls through to
   * `resolveJsonlPath`'s directory-scan fallback instead of failing the
   * request.
   */
  app.get("/api/conversation/:agentSessionId/live-tail", async (req, res) => {
    const rawId = req.params.agentSessionId;
    if (!rawId) {
      res.status(400).json({ error: "Conversation id required" });
      return;
    }
    // Mint at the boundary: this path param is a harness ConversationId, not a
    // Minsky workspace sessionId (see the id-space note in the docblock above).
    const agentSessionId = decodeURIComponent(rawId) as ConversationId;

    try {
      // 1. Optional fast-path: look up projectDir directly from
      //    agent_transcripts by agentSessionId (no cwd/workspace query of any
      //    kind). Best-effort only — any failure (DB unavailable, transcript
      //    not yet ingested) leaves projectDir null and resolveJsonlPath falls
      //    back to its directory scan.
      let projectDir: string | null = null;
      try {
        const db = await getContextInspectorDb();
        if (db) {
          const { agentTranscriptsTable } = await import(
            "@minsky/domain/storage/schemas/agent-transcripts-schema"
          );
          const { eq, desc, sql } = await import("drizzle-orm");
          const rows = await db
            .select({ projectDir: agentTranscriptsTable.projectDir })
            .from(agentTranscriptsTable)
            .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
            .orderBy(sql`${desc(agentTranscriptsTable.startedAt)} NULLS LAST`)
            .limit(1);
          projectDir = rows[0]?.projectDir ?? null;
        }
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        log.debug(`[conversation] projectDir fast-path degraded: ${msg}`);
      }

      // 2. Locate the JSONL file on disk (fast path via projectDir, else a
      //    one-level scan under the Claude Code projects dir).
      const { resolveJsonlPath, startLiveTail } = await import("../live-tail-poller");
      const jsonlPath = await resolveJsonlPath(agentSessionId, {
        projectDir,
        claudeProjectsDir: claudeProjectsDirOverride,
        fsMod,
      });
      if (!jsonlPath) {
        res.status(404).json({
          error:
            "JSONL transcript file not found on disk — conversation may not have written any turns yet",
        });
        return;
      }

      // 3. Set SSE response headers and start streaming (identical shape to
      //    the workspace-keyed endpoint's steps 4-5 in routes/agents.ts).
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      let closed = false;

      function sendBlock(
        block: import("@minsky/domain/context/types").SessionContextSnapshotBlock
      ): void {
        if (closed) return;
        res.write(`data: ${JSON.stringify(block)}\n\n`);
      }

      // 4. Start the polling loop (seeds tailer to current EOF).
      const stopTail = await startLiveTail(jsonlPath, agentSessionId, sendBlock, {
        tailer,
        statFn,
        pollMs,
      });

      // Heartbeat to prevent proxy timeout.
      const heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": keep-alive\n\n");
      }, 30_000);

      // Cleanup on client disconnect.
      req.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        stopTail();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `[conversation] GET /api/conversation/:agentSessionId/live-tail — internal error: ${message}`
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "An internal error occurred while starting live tail." });
      }
    }
  });
}
