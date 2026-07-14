/**
 * Cockpit agent (workspace-session) routes (mt#2615 — extracted from
 * server.ts, mt#1919 / mt#2232).
 *
 *   GET /api/agents/:id            — workspace-session detail (mt#1919)
 *   GET /api/agents/:id/live-tail  — Rung-1 live-tail SSE stream (mt#2232)
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import {
  getServerSessionProvider,
  getServerTaskService,
  getContextInspectorDb,
} from "../db-providers";

/** Mount /api/agents/:id and /api/agents/:id/live-tail on `app`. */
export function mountAgentRoutes(app: express.Express): void {
  /**
   * GET /api/agents/:id — workspace-session detail for the drill-down page
   * (mt#1919). Keyed by the MINSKY workspace sessionId (not the harness
   * agentSessionId — see src/cockpit/session-detail.ts header).
   *
   * Returns: SessionDetailPayload { session, commits, pr, conversation }
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

      const { buildSessionMeta, buildPrRef, githubRepoWebBase, parseGitLog, GIT_LOG_FORMAT } =
        await import("../session-detail");

      // Workspace dir: record fields first, provider lookup as fallback.
      let workdir: string | null = record.workspacePath ?? record.sessionPath ?? null;
      if (!workdir) {
        try {
          workdir = await provider.getSessionWorkdir(sessionId);
        } catch {
          workdir = null;
        }
      }

      // Enrichments run in parallel; each degrades to a safe default.
      const repoWebBase = githubRepoWebBase(record.repoUrl);

      const commitsPromise: Promise<ReturnType<typeof parseGitLog>> = (async () => {
        if (!workdir) return [];
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        // .git may be a directory (normal checkout) or a file (worktree
        // indirection) — existsSync covers both. A workspace without it is
        // not a git checkout; skip rather than let git walk up to a parent repo.
        if (!existsSync(workdir) || !existsSync(join(workdir, ".git"))) {
          log.debug(`[agents] commits enrichment skipped — no git workspace at ${workdir}`);
          return [];
        }
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["-C", workdir, "log", `--format=${GIT_LOG_FORMAT}`, "-n", "10"],
            { timeout: 5_000, maxBuffer: 256 * 1024 }
          );
          return parseGitLog(stdout, repoWebBase);
        } catch (gitErr) {
          const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
          log.debug(`[agents] commits enrichment degraded — git log failed: ${msg}`);
          return [];
        }
      })();

      const taskTitlePromise: Promise<string | null> = (async () => {
        if (!record.taskId) return null;
        try {
          const taskService = await getServerTaskService();
          if (!taskService) return null;
          const task = await taskService.getTask(record.taskId);
          return task?.title ?? null;
        } catch (titleErr) {
          const msg = titleErr instanceof Error ? titleErr.message : String(titleErr);
          log.debug(`[agents] task-title enrichment degraded: ${msg}`);
          return null;
        }
      })();

      // Workspace → transcript resolution (mt#2441): consult
      // minsky_session_links FIRST — the materialized cwd_match join written
      // at ingest time (AgentTranscriptIngestService) and backfilled for
      // pre-existing transcripts (scripts/backfill-minsky-session-links.ts).
      // Only fall back to the live cwd LIKE query (newest agent_transcripts
      // row whose cwd is the session workspace or below) for transcripts that
      // have no link row yet — pre-backfill, or ingested before this shipped.
      // Full removal of the LIKE fallback is a separate task (mt#2768).
      const conversationPromise: Promise<{ agentSessionId: string } | null> = (async () => {
        try {
          const db = await getContextInspectorDb();
          if (!db) return null;
          const { agentTranscriptsTable } = await import(
            "@minsky/domain/storage/schemas/agent-transcripts-schema"
          );
          const { minskySessionLinksTable } = await import(
            "@minsky/domain/storage/schemas/minsky-session-links-schema"
          );
          const { eq, like, or, desc, sql } = await import("drizzle-orm");

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
            .where(eq(minskySessionLinksTable.minskySessionId, sessionId));

          const { pickBestConversationLink } = await import("../session-detail");
          const linked = pickBestConversationLink(linkRows);
          if (linked) return linked;

          if (!workdir) return null;
          // Fallback: match workdir + descendants (POSIX "/" and Windows "\")
          // via the shared escape helper so the two transcript-resolution
          // routes cannot drift on the backslash-escape level (mt#2232 R1).
          const { cwdDescendantLikePatterns } = await import("../live-tail-poller");
          const { posix: cwdPosix, windows: cwdWindows } = cwdDescendantLikePatterns(workdir);
          const rows = await db
            .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
            .from(agentTranscriptsTable)
            .where(
              or(
                eq(agentTranscriptsTable.cwd, workdir),
                like(agentTranscriptsTable.cwd, cwdPosix),
                like(agentTranscriptsTable.cwd, cwdWindows)
              )
            )
            .orderBy(sql`${desc(agentTranscriptsTable.startedAt)} NULLS LAST`)
            .limit(1);
          const first = rows[0];
          return first ? { agentSessionId: first.agentSessionId } : null;
        } catch (convErr) {
          const msg = convErr instanceof Error ? convErr.message : String(convErr);
          log.debug(`[agents] conversation enrichment degraded: ${msg}`);
          return null;
        }
      })();

      const [commits, taskTitle, conversation] = await Promise.all([
        commitsPromise,
        taskTitlePromise,
        conversationPromise,
      ]);

      res.json({
        session: buildSessionMeta(record, taskTitle),
        commits,
        pr: buildPrRef(record),
        conversation,
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

      let workdir: string | null = record.workspacePath ?? record.sessionPath ?? null;
      if (!workdir) {
        try {
          workdir = await provider.getSessionWorkdir(workspaceSessionId);
        } catch {
          workdir = null;
        }
      }

      if (!workdir) {
        res.status(404).json({ error: "Session workspace directory not resolvable" });
        return;
      }

      // 2. Resolve agentSessionId + projectDir from the transcripts table.
      //    Reuses the same DB query as /api/agents/:id conversationPromise.
      const db = await getContextInspectorDb();
      if (!db) {
        res.status(503).json({
          error: "DB unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const { agentTranscriptsTable } = await import(
        "@minsky/domain/storage/schemas/agent-transcripts-schema"
      );
      const { eq, like, or, desc, sql } = await import("drizzle-orm");
      const { cwdDescendantLikePatterns } = await import("../live-tail-poller");
      const { posix: cwdPosix, windows: cwdWindows } = cwdDescendantLikePatterns(workdir);
      const rows = await db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          projectDir: agentTranscriptsTable.projectDir,
        })
        .from(agentTranscriptsTable)
        .where(
          or(
            eq(agentTranscriptsTable.cwd, workdir),
            like(agentTranscriptsTable.cwd, cwdPosix),
            like(agentTranscriptsTable.cwd, cwdWindows)
          )
        )
        .orderBy(sql`${desc(agentTranscriptsTable.startedAt)} NULLS LAST`)
        .limit(1);

      const first = rows[0];
      if (!first) {
        res.status(404).json({
          error: "No transcript found for this session — may not have started yet",
        });
        return;
      }

      const { agentSessionId, projectDir } = first;

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
