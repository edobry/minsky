/**
 * Cockpit agent (workspace-session) routes (mt#2615 — extracted from
 * server.ts, mt#1919 / mt#2232).
 *
 *   GET /api/agents/:id            — workspace-session detail (mt#1919)
 *   GET /api/agents/:id/live-tail  — Rung-1 live-tail SSE stream (mt#2232)
 */
import type express from "express";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import {
  getServerSessionProvider,
  getContextInspectorDb,
  describeServerPersistenceUnavailability,
} from "../db-providers";
import {
  resolveDerivedConversationLinks,
  type ConversationLinkSource,
} from "../derived-conversation-link";
import { ServerTimingRecorder } from "../server-timing";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";

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
 * HEURISTIC-free resolution mechanism now, and nothing here reinstates a
 * heuristic query.
 *
 * Derived fallback (mt#3529): when the link-row query comes back EMPTY, the
 * workspace record's own `agentId` is consulted — see
 * ../derived-conversation-link. That is a recorded fact about the workspace,
 * not a heuristic match, and the candidate it produces is existence-checked
 * against `agent_transcripts` before being emitted. It is marked
 * `source: "derived-agent-id"` so callers can tell it from a stamped row; a
 * stamped row always wins, because the fallback only runs when there is none.
 *
 * Exported, with `getDb` injectable, for the contract test in
 * `../conversation-link-contract.test.ts` — the `source` discriminator is on
 * the `/api/agents/:id` response and needs coverage that fails if either
 * branch stops emitting it. Injection rather than a module mock per
 * `custom/no-global-module-mocks`; production callers pass nothing and get the
 * shared cockpit connection.
 *
 * @returns every candidate row, newest-`startedAt`-first — the run-detail
 *   page's conversation switcher (mt#2768 Behavior: "multi-conversation
 *   workspaces") needs the FULL set, not just the best one. `confidence` is
 *   retained (not just exposed via the response) so the caller can still
 *   feed the FULL candidate set into `pickBestConversationLink` for the
 *   back-compat singular `conversation` field.
 *
 *   `linkType`, `cwd`, and `generatedTitle` are carried too (mt#3691). The
 *   first is the candidate's provenance, which the switcher renders so an
 *   operator can tell an orchestrator conversation from a subagent transcript;
 *   the other two are label INPUTS. All three are free here — both tables are
 *   already joined — whereas the four-query enrichment that turns them into a
 *   label is NOT free, which is why it lives in
 *   `../conversation-candidate-labels` and only the detail route opts in. This
 *   function's other caller (`/api/agents/:id/live-tail`) discards everything
 *   but the best id and must not start paying for labels.
 */
export async function resolveWorkspaceConversations(
  minskySessionId: string,
  workspaceAgentId?: string | null,
  getDb: () => Promise<PostgresJsDatabase | null> = getContextInspectorDb
): Promise<
  Array<{
    agentSessionId: string;
    confidence: number | null;
    startedAt: string | null;
    source: ConversationLinkSource;
    /**
     * `minsky_session_links.link_type` — null on a derived candidate, which
     * has no link row by construction.
     */
    linkType: string | null;
    cwd: string | null;
    generatedTitle: string | null;
  }>
> {
  try {
    const db = await getDb();
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
        linkType: minskySessionLinksTable.linkType,
        cwd: agentTranscriptsTable.cwd,
        title: agentTranscriptsTable.title,
      })
      .from(minskySessionLinksTable)
      .innerJoin(
        agentTranscriptsTable,
        eq(agentTranscriptsTable.agentSessionId, minskySessionLinksTable.agentSessionId)
      )
      .where(eq(minskySessionLinksTable.minskySessionId, minskySessionId))
      .orderBy(sql`${desc(agentTranscriptsTable.startedAt)} NULLS LAST`);

    if (linkRows.length > 0) {
      return linkRows.map((r) => ({
        agentSessionId: r.agentSessionId,
        confidence: r.confidence,
        startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : null,
        source: "link-row" as const,
        linkType: r.linkType,
        cwd: r.cwd,
        generatedTitle: r.title,
      }));
    }

    // mt#3529 — no writer stamped a row for this workspace. Fall back to the
    // conversation its OWN agentId names, if that conversation is ingested.
    const derived = await resolveDerivedConversationLinks(db, [
      { sessionId: minskySessionId, agentId: workspaceAgentId },
    ]);
    const derivedLink = derived.get(minskySessionId);
    if (!derivedLink) return [];
    return [
      {
        agentSessionId: derivedLink.agentSessionId,
        // No stamped confidence exists for a derived link; `source` carries
        // the provenance instead, so leave this null rather than inventing a
        // number that would sort against real writer confidences.
        confidence: null,
        startedAt: derivedLink.startedAt,
        source: "derived-agent-id" as const,
        // A derived candidate has no link row, so there is no link_type to
        // report — the `source` field already carries its provenance, and the
        // switcher renders no chip rather than inventing one. `cwd` and the
        // generated title are not read on this path either: a derived link is
        // returned ALONE (it only runs when the link-row query came back
        // empty), so the switcher — which needs 2+ candidates — never renders
        // it, and the singular `conversation` field it does feed carries no
        // label.
        linkType: null,
        cwd: null,
        generatedTitle: null,
      },
    ];
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
    // Express already URI-decodes route params once — a second
    // decodeURIComponent() here would corrupt any sessionId containing a
    // literal `%` and can throw on a malformed escape sequence (mt#2286 R1
    // review finding; fixed here as the class-not-instance sibling of the
    // same bug in ./agent-focus.ts).
    const sessionId = req.params.id;
    if (!sessionId) {
      res.status(400).json({ error: "Session ID required" });
      return;
    }

    // mt#3710 — per-phase attribution, so this route's cost is answerable the
    // way mt#3696 made the task-detail route's answerable. Attached (not
    // applied per-exit) so the 503/404/500 replies carry it too.
    const timing = new ServerTimingRecorder();
    timing.attachTo(res);

    try {
      const provider = await timing.time("provider", () => getServerSessionProvider());
      if (!provider) {
        res.status(503).json({
          error: `Session service unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }

      const record = await timing.time("session", () => provider.getSession(sessionId));
      if (!record) {
        res.status(404).json({ error: `Session ${sessionId} not found` });
        return;
      }

      // mt#3710 — started HERE, before the workdir lookup, not after it. This
      // read needs only `record.agentId`; it has nothing to do with the
      // workspace directory, so waiting for that lookup was ~300ms of pure
      // serialization. Measured before this change: session 305ms -> workdir
      // 308ms -> convs 154ms -> labels 620ms, a ~1390ms handler.
      //
      // `labels` chains off THIS promise rather than off the `Promise.all`
      // below, for the same reason: it needs the conversations and nothing
      // else, so pinning it behind the workspace overview would hand back most
      // of what starting the read early just bought.
      const conversationsPromise = timing.time("convs", () =>
        resolveWorkspaceConversations(sessionId, record.agentId)
      );

      // Workspace dir: record fields first, provider lookup as fallback.
      let workdir: string | null = record.workspacePath ?? record.sessionPath ?? null;
      if (!workdir) {
        workdir = await timing.time("workdir", async () => {
          try {
            return await provider.getSessionWorkdir(sessionId);
          } catch {
            return null;
          }
        });
      }

      const { buildWorkspaceOverview } = await import("../workspace-overview");
      // Timed from CREATION, not from an await. A promise begins executing the
      // moment it is constructed, so timing only the await would measure the
      // time REMAINING when control reached it and silently understate the
      // phase — the first pass at this instrumentation did exactly that and
      // left ~300ms unattributed.
      const overviewPromise = timing.time("overview", () =>
        buildWorkspaceOverview(record, workdir)
      );

      // mt#3691 — label every candidate with the run list's own precedence, so
      // the switcher names conversations instead of listing uuids. Computed
      // HERE rather than inside `resolveWorkspaceConversations` because the
      // live-tail route shares that function and discards everything but the
      // best id (see its @returns note).
      //
      // Labeled unconditionally, not only at the 2+-candidate threshold the
      // switcher renders at: a conditionally-present field is a contract every
      // consumer has to special-case, and the cost is the same four batched
      // queries the conversation-overview route already pays per request for a
      // SINGLE conversation on this same page family. Degrades to absent (not
      // to a uuid) when the DB is unavailable, matching every other enrichment
      // in this handler.
      // Timed inside the `.then`, so `labels` measures the labeling work ALONE
      // and excludes the `convs` wait it depends on (PR #2639 R1 suggested
      // `timing.time("labels", async () => { const convs = await
      // conversationsPromise; ... })` instead — that form makes `labels`
      // subsume `convs`, so the two phases double-count and the sum exceeds the
      // handler total, which is the opposite of the attribution this task
      // needs). Nothing runs between the `.then` entry and the timer, so there
      // is no gap for it to hide; keep it that way.
      const labelsPromise = conversationsPromise.then((convs) =>
        timing.time("labels", async () => {
          try {
            const db = await getContextInspectorDb();
            if (!db) return new Map<string, string>();
            const { labelConversationCandidates } = await import(
              "../conversation-candidate-labels"
            );
            const { getSharedTaskTitleCache } = await import("../shared-task-title-cache");
            return await labelConversationCandidates(db, convs, await getSharedTaskTitleCache());
          } catch (labelErr) {
            const msg = labelErr instanceof Error ? labelErr.message : String(labelErr);
            log.debug(`[agents] candidate labeling degraded: ${msg}`);
            return new Map<string, string>();
          }
        })
      );

      const [{ session, commits, pr }, conversations, labels] = await Promise.all([
        overviewPromise,
        conversationsPromise,
        labelsPromise,
      ]);

      // Everything after the reads, timed as one phase to test where the
      // handler's unaccounted time goes (PR #2639 R1): the critical path
      // (session + convs + labels) measures ~1108ms against a ~1259ms total.
      //
      // It is NOT here. This phase measures 0.04ms, which falsifies the
      // dynamic-imports-and-assembly hypothesis it was added to test. The
      // ~150ms residual is real, reproducible, and currently unexplained — it
      // sits between the last read resolving and the response being written,
      // and is left NAMED-as-unknown rather than quietly folded into a
      // neighbouring phase. Kept because a phase that reads 0.04ms is the
      // evidence for that, and deleting it would put the next reader back at
      // the same wrong hypothesis.
      const { conversation, driven } = await timing.time("assemble", async () => {
        const { pickBestConversationLink } = await import("../session-detail");
        const best = pickBestConversationLink(conversations);

        // mt#2752 — surface an app-started driven session bound to this
        // workspace (newest first if several), so the run-detail page can
        // offer the live drive view (/driven/:id). In-process registry read;
        // empty on deployments with no driven-session host.
        let boundDriven: { sessionId: string; status: string } | null = null;
        try {
          const { drivenSessionRegistry } = await import("../driven-session-host");
          const bound = drivenSessionRegistry
            .list()
            .filter((r) => r.minskySessionId === sessionId)
            .at(-1);
          if (bound) boundDriven = { sessionId: bound.localId, status: bound.status };
        } catch {
          boundDriven = null;
        }

        return { conversation: best, driven: boundDriven };
      });

      res.json({
        session,
        commits,
        pr,
        conversation,
        conversations: conversations.map((c) => ({
          agentSessionId: c.agentSessionId,
          startedAt: c.startedAt,
          // mt#3529 — provenance, so a consumer can tell a writer-stamped link
          // from one derived from the workspace's own (unforgeable-only-by-
          // convention, per ADR-006) agentId.
          source: c.source,
          // mt#3691 — the FINER provenance the switcher renders: which of the
          // five writer classes stamped this row. `source` only distinguishes
          // stamped-vs-derived; this says which writer, so an operator can
          // tell the conversation that CREATED the workspace from a subagent
          // that worked in it.
          linkType: c.linkType,
          // Absent (not a uuid) when labeling degraded — the client falls back
          // to a shortened id rather than rendering an empty item.
          ...(labels.has(c.agentSessionId) ? { label: labels.get(c.agentSessionId) } : {}),
        })),
        driven,
      });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "agents")) return;
      log.error(`[agents] GET /api/agents/:id — internal error: ${getLoggableErrorSummary(err)}`);
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
    // See the /api/agents/:id handler above — Express already decodes route
    // params once; do not decode again (mt#2286 R1 review finding).
    const workspaceSessionId = req.params.id;
    if (!workspaceSessionId) {
      res.status(400).json({ error: "Session ID required" });
      return;
    }

    try {
      // 1. Resolve workspace session → workdir (same pattern as /api/agents/:id)
      const provider = await getServerSessionProvider();
      if (!provider) {
        res.status(503).json({
          error: `Session service unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }

      const record = await provider.getSession(workspaceSessionId);
      if (!record) {
        res.status(404).json({ error: `Session ${workspaceSessionId} not found` });
        return;
      }

      // 2. Resolve agentSessionId via the join (mt#2768 — "workspace-keyed
      //    resolution via the join" success criterion). Still no cwd LIKE
      //    fallback; a workspace with no resolvable conversation is reported
      //    unresolved rather than falling back to a live cwd heuristic query.
      //    mt#3529 adds the same derived-from-agentId fallback the detail
      //    route uses — a live tail is exactly as dead as the Conversation tab
      //    when a link row was never stamped, so both consult it.
      const db = await getContextInspectorDb();
      if (!db) {
        res.status(503).json({
          error: `DB unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }

      const { pickBestConversationLink } = await import("../session-detail");
      const candidates = await resolveWorkspaceConversations(workspaceSessionId, record.agentId);
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
      if (await respondIfDatabaseUnavailable(res, err, "agents")) return;
      log.error(
        `[agents] GET /api/agents/:id/live-tail — internal error: ${getLoggableErrorSummary(err)}`
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "An internal error occurred while starting live tail." });
      }
    }
  });
}
