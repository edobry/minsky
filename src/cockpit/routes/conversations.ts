/**
 * Cockpit conversation-keyed routes (mt#2749 — the conversation-keyed sibling
 * of the workspace-keyed live tail at `src/cockpit/routes/agents.ts`; mt#2768
 * adds the conversation-keyed Overview data source for the tabbed run-detail
 * page).
 *
 *   GET /api/conversation/:agentSessionId/live-tail  — conversation-keyed live-tail SSE stream
 *   GET /api/conversation/:agentSessionId/overview    — conversation-keyed run overview (mt#2768)
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
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import { getContextInspectorDb, getServerSessionProvider } from "../db-providers";
import type { ConversationId } from "@minsky/domain/ids";
import type { ResolveJsonlFsMod, StatFn, TailerLike } from "../live-tail-poller";
import { looksLikeConversationId, withBoundedTimeout } from "../conversation-id-space";

/**
 * Bound for the `/overview` transcript lookup (mt#3131 D3) — see the sibling
 * bound on the context-inspector snapshot route
 * (`SNAPSHOT_ASSEMBLY_TIMEOUT_MS`) for the same rationale: a DB pool under
 * contention must not leave this response pending indefinitely.
 */
const OVERVIEW_QUERY_TIMEOUT_MS = 15_000;

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
  /**
   * Test seam (mt#3016) — overrides the cockpit-wide SQL connection getter
   * used by BOTH routes in this file (the live-tail projectDir fast-path
   * AND the overview route's transcript lookup). Production callers omit
   * this, so both routes fall back to the real `getContextInspectorDb()`
   * singleton, exactly matching pre-mt#3016 behavior. Mirrors the same DI
   * pattern already used by `routes/agent-focus.ts`'s `getDb` option.
   *
   * Exists because `getContextInspectorDb()` is a module-level singleton
   * shared across every test file in the same `bun test` process — its "no
   * live Postgres in the test environment" assumption
   * (`server-conversation-overview.test.ts`'s own test titles) is NOT
   * guaranteed: confirmed empirically that
   * `packages/domain/src/session-auto-task-creation.test.ts` running first
   * in the same process (its `beforeEach` calls
   * `@minsky/domain/configuration`'s equally global, equally un-reset
   * `initializeConfiguration()`, which still merges in the real user-level
   * `~/.config/minsky/config.yaml`) makes this resolve a REAL, non-null
   * connection — flipping the overview route's expected 503 to a 404 (a
   * real "conversation not found" lookup against the live transcripts
   * table, since the test's fake conversation id has no matching row).
   */
  getDb?: () => Promise<PostgresJsDatabase | null>;
}

/** Mount /api/conversation/:agentSessionId/live-tail on `app`. */
export function mountConversationRoutes(
  app: express.Express,
  opts: ConversationRoutesOptions = {}
): void {
  const { claudeProjectsDirOverride, fsMod, tailer, statFn, pollMs, getDb: getDbOverride } = opts;
  const getDb = getDbOverride ?? getContextInspectorDb;

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
        const db = await getDb();
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

      // 3. Set SSE response headers and start streaming. Use per-header
      //    `setHeader` + `status` rather than `writeHead(200, {...})`: the
      //    object form of `writeHead` bypasses Express's header store and can
      //    clobber headers set by upstream middleware (e.g. the mt#2538 CSP
      //    middleware, which runs on GET responses). `setHeader` merges with
      //    those instead. `flushHeaders()` then commits the status line +
      //    headers before the first `data:` frame so proxies open the stream.
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
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

  /**
   * GET /api/conversation/:agentSessionId/overview — conversation-keyed run
   * overview for the tabbed run-detail page (mt#2768).
   *
   * Id-space: `:agentSessionId` is the harness ConversationId. Resolves the
   * REVERSE join (conversation -> owning workspace) via
   * `minsky_session_links`, the mirror of the workspace-keyed join in
   * `routes/agents.ts`. When a workspace resolves, the response carries the
   * SAME `{ session, commits, pr }` shape `/api/agents/:id` returns (built by
   * the shared `buildWorkspaceOverview`) so the Overview tab renders
   * identically regardless of which route the operator arrived from. When no
   * workspace resolves (a plain principal conversation, or a dispatched
   * subagent whose link hasn't landed yet), `workspace` is `null` and the
   * Overview tab falls back to `conversationMeta` (cwd, harness, started,
   * turn count) — mt#2768 Behavior: "workspace-less runs collapse Overview to
   * conversation metadata."
   *
   * Returns 404 only when the conversation itself is unknown (no
   * `agent_transcripts` row) — a resolvable conversation with no workspace
   * link is a 200 with `workspace: null`, not an error.
   */
  app.get("/api/conversation/:agentSessionId/overview", async (req, res) => {
    const rawId = req.params.agentSessionId;
    if (!rawId) {
      res.status(400).json({ error: "Conversation id required" });
      return;
    }
    const agentSessionId = decodeURIComponent(rawId) as ConversationId;

    try {
      const db = await getDb();
      if (!db) {
        res.status(503).json({
          error: "DB unavailable — persistence provider does not support SQL",
        });
        return;
      }

      // mt#3131 (D3/D5): a syntactically-invalid conversation id (not
      // UUID-shaped) can never resolve — reject before the transcript query
      // (checked after DB-availability so a genuine 503 still takes
      // precedence, matching the pre-existing "infra unavailable" contract),
      // both for speed (zero I/O, can never hang) and so the client can
      // distinguish "not found" from "not yet ingested" (mirrors the same
      // check on the context-inspector snapshot endpoint).
      if (!looksLikeConversationId(agentSessionId)) {
        res.status(404).json({
          error: `"${agentSessionId}" is not a valid conversation id.`,
          code: "invalid_id",
        });
        return;
      }

      const { agentTranscriptsTable } = await import(
        "@minsky/domain/storage/schemas/agent-transcripts-schema"
      );
      const { agentTranscriptTurnsTable } = await import(
        "@minsky/domain/storage/schemas/agent-transcript-turns-schema"
      );
      const { minskySessionLinksTable } = await import(
        "@minsky/domain/storage/schemas/minsky-session-links-schema"
      );
      const { eq, count } = await import("drizzle-orm");

      // mt#3131 (D3): bound the lookup — a DB pool under contention (e.g. a
      // live conversation's own polling load) must not leave this response
      // pending indefinitely.
      const transcriptRows = await withBoundedTimeout(
        db
          .select({
            harness: agentTranscriptsTable.harness,
            cwd: agentTranscriptsTable.cwd,
            startedAt: agentTranscriptsTable.startedAt,
            endedAt: agentTranscriptsTable.endedAt,
            // mt#2792 Overview enrichment — regex-extracted refs (mt#1329
            // metadata-extractor) and the incremental-ingest high-water-mark
            // (used as the duration fallback for a conversation with no
            // endedAt yet, i.e. one still in progress).
            relatedTaskIds: agentTranscriptsTable.relatedTaskIds,
            relatedPrNumbers: agentTranscriptsTable.relatedPrNumbers,
            lastIngestedJsonlTimestamp: agentTranscriptsTable.lastIngestedJsonlTimestamp,
          })
          .from(agentTranscriptsTable)
          .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
          .limit(1),
        OVERVIEW_QUERY_TIMEOUT_MS
      );

      const transcript = transcriptRows[0];
      if (!transcript) {
        res.status(404).json({ error: `Conversation ${agentSessionId} not found` });
        return;
      }

      const turnCountPromise: Promise<number> = (async () => {
        try {
          const rows = await db
            .select({ n: count() })
            .from(agentTranscriptTurnsTable)
            .where(eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId));
          return rows[0]?.n ?? 0;
        } catch (turnErr) {
          const msg = turnErr instanceof Error ? turnErr.message : String(turnErr);
          log.debug(`[conversation] turn-count enrichment degraded: ${msg}`);
          return 0;
        }
      })();

      const workspacePromise: Promise<Awaited<
        ReturnType<typeof import("../workspace-overview").buildWorkspaceOverview>
      > | null> = (async () => {
        try {
          const { pickBestWorkspaceLink } = await import("../session-detail");
          const linkRows = await db
            .select({
              minskySessionId: minskySessionLinksTable.minskySessionId,
              confidence: minskySessionLinksTable.confidence,
              detectedAt: minskySessionLinksTable.detectedAt,
            })
            .from(minskySessionLinksTable)
            .where(eq(minskySessionLinksTable.agentSessionId, agentSessionId));

          const best = pickBestWorkspaceLink(linkRows);
          if (!best) return null;

          const provider = await getServerSessionProvider();
          if (!provider) return null;
          const record = await provider.getSession(best.minskySessionId);
          if (!record) return null;

          let workdir: string | null = record.workspacePath ?? record.sessionPath ?? null;
          if (!workdir) {
            try {
              workdir = await provider.getSessionWorkdir(best.minskySessionId);
            } catch {
              workdir = null;
            }
          }

          const { buildWorkspaceOverview } = await import("../workspace-overview");
          return await buildWorkspaceOverview(record, workdir);
        } catch (wsErr) {
          const msg = wsErr instanceof Error ? wsErr.message : String(wsErr);
          log.debug(`[conversation] reverse-join workspace resolution degraded: ${msg}`);
          return null;
        }
      })();

      const [turnCount, workspace] = await Promise.all([turnCountPromise, workspacePromise]);

      res.json({
        agentSessionId,
        conversationMeta: {
          cwd: transcript.cwd,
          harness: transcript.harness,
          startedAt:
            transcript.startedAt instanceof Date ? transcript.startedAt.toISOString() : null,
          endedAt: transcript.endedAt instanceof Date ? transcript.endedAt.toISOString() : null,
          turnCount,
          relatedTaskIds: transcript.relatedTaskIds ?? [],
          relatedPrNumbers: transcript.relatedPrNumbers ?? [],
          lastActivityAt:
            transcript.lastIngestedJsonlTimestamp instanceof Date
              ? transcript.lastIngestedJsonlTimestamp.toISOString()
              : null,
        },
        workspace,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `[conversation] GET /api/conversation/:agentSessionId/overview — internal error: ${message}`
      );
      res
        .status(500)
        .json({ error: "An internal error occurred while fetching the conversation overview." });
    }
  });
}
