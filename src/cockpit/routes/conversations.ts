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
import {
  getContextInspectorDb,
  getServerSessionProvider,
  describeServerPersistenceUnavailability,
} from "../db-providers";
import type { ConversationId } from "@minsky/domain/ids";
import type { ResolveJsonlFsMod, StatFn, TailerLike } from "../live-tail-poller";
import { looksLikeConversationId, withBoundedTimeout } from "../conversation-id-space";
import { ServerTimingRecorder } from "../server-timing";
import { OverviewCache } from "../snapshot-cache";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";

/**
 * Bound for the `/overview` transcript lookup (mt#3131 D3) — see the sibling
 * bound on the context-inspector snapshot route
 * (`SNAPSHOT_ASSEMBLY_TIMEOUT_MS`) for the same rationale: a DB pool under
 * contention must not leave this response pending indefinitely.
 */
const OVERVIEW_QUERY_TIMEOUT_MS = 15_000;

/**
 * The `/overview` response body, cached whole (mt#4429).
 *
 * Declared as a type rather than left inferred so `overviewCache` below can be
 * parameterized by it — a cache typed `unknown` would let a shape change on the
 * write side pass unnoticed on the read side, which for a route whose only job
 * is to hand this object to `res.json` is exactly the mistake worth preventing.
 */
type ConversationOverviewResponse = {
  agentSessionId: string;
  label: string;
  conversationMeta: {
    cwd: string | null;
    harness: string | null;
    startedAt: string | null;
    endedAt: string | null;
    turnCount: number;
    relatedTaskIds: string[];
    // `string[]`, not `number[]` — the column stores PR refs as text. Asserted
    // here because assuming otherwise is exactly what this type caught.
    relatedPrNumbers: string[];
    lastActivityAt: string | null;
    writerDivergence: { checked: boolean; divergentTips: string[] };
  };
  workspace: Awaited<
    ReturnType<typeof import("../workspace-overview").buildWorkspaceOverview>
  > | null;
};

/**
 * Process-local cache for `/overview` payloads (mt#4429).
 *
 * Module-level, so it is shared across requests and survives for the daemon's
 * life — the same placement `routes/context-inspector.ts` uses for
 * `snapshotCache` / `structureCache`. See `OverviewCache`'s docblock for why a
 * hit requires BOTH a token match and a freshness ceiling.
 */
const overviewCache = new OverviewCache<ConversationOverviewResponse>();

/**
 * Cache-validity token for one conversation's overview.
 *
 * Built from columns the `/overview` handler ALREADY selects, so validating a
 * cache entry costs no extra round trip — the point of putting the check after
 * the transcript read rather than before it.
 *
 * `lastIngestedJsonlTimestamp` is the incremental-ingest high-water-mark, so it
 * advances whenever new turns land; `endedAt` and `divergenceCheckedAt` cover
 * the two other row mutations the payload renders. A live conversation's token
 * therefore changes as it grows, which is what keeps a running conversation's
 * turn count from going stale — see `OverviewCache` for the half of validity
 * this token deliberately cannot cover.
 */
function overviewVersionToken(row: {
  endedAt: Date | string | null;
  lastIngestedJsonlTimestamp: Date | string | null;
  divergenceCheckedAt: Date | string | null;
}): string {
  const stamp = (value: Date | string | null): string =>
    value instanceof Date ? value.toISOString() : (value ?? "-");
  return [
    stamp(row.lastIngestedJsonlTimestamp),
    stamp(row.endedAt),
    stamp(row.divergenceCheckedAt),
  ].join("|");
}

/**
 * Task-title cache for the overview route's label computation (mt#3343).
 *
 * The singleton itself moved to `../shared-task-title-cache` (mt#3691) once
 * `routes/agents.ts` began labeling its conversation candidates through the
 * same precedence: two module-private caches would be two caches over one task
 * backend, warming and expiring independently. This thin alias keeps the
 * call site below reading the same way it did.
 */
async function getOverviewTitleCache(): Promise<
  import("../task-title-cache").TaskTitleCache | null
> {
  const { getSharedTaskTitleCache } = await import("../shared-task-title-cache");
  return getSharedTaskTitleCache();
}

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
      if (await respondIfDatabaseUnavailable(res, err, "conversations")) return;
      log.error(
        `[conversation] GET /api/conversation/:agentSessionId/live-tail — internal error: ${getLoggableErrorSummary(err)}`
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

    // mt#3710 — per-phase attribution for the conversation overview, matching
    // the task-detail route mt#3696 instrumented.
    const timing = new ServerTimingRecorder();
    timing.attachTo(res);

    try {
      const db = await timing.time("db", () => getDb());
      if (!db) {
        res.status(503).json({
          error: `DB unavailable — ${await describeServerPersistenceUnavailability()}`,
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
      const transcriptRows = await timing.time("transcript", () =>
        withBoundedTimeout(
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
              // mt#3321 generated title — tier 2 of the label precedence, read
              // off the row already being selected here (no extra query).
              title: agentTranscriptsTable.title,
              // mt#3656 writer-divergence verdict — same free ride off this row.
              divergentTipLeaves: agentTranscriptsTable.divergentTipLeaves,
              divergenceCheckedAt: agentTranscriptsTable.divergenceCheckedAt,
            })
            .from(agentTranscriptsTable)
            .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
            .limit(1),
          OVERVIEW_QUERY_TIMEOUT_MS
        )
      );

      const transcript = transcriptRows[0];
      if (!transcript) {
        res.status(404).json({ error: `Conversation ${agentSessionId} not found` });
        return;
      }

      // mt#4429 — the cache check sits HERE, after the transcript read and
      // before the three expensive legs below, because the validity token is
      // built from columns that read already returned. Checking earlier would
      // need its own round trip to fetch them, which on a remote database costs
      // about as much as one of the legs it is trying to skip.
      //
      // What a hit skips is the whole rest of the handler: `enrichment`
      // (measured 370-667ms), `turns+workspace` (436-455ms), and the label
      // computation. What it still pays is the one `transcript` round trip
      // (~145ms) — so a hit is bounded by DB latency, not by the payload.
      const cacheToken = overviewVersionToken(transcript);
      const cachedOverview = overviewCache.get(agentSessionId, cacheToken, Date.now());
      if (cachedOverview !== undefined) {
        timing.record("cache", 0, "hit");
        res.json(cachedOverview);
        return;
      }

      // mt#3710 — the label's DB enrichment needs only `db` and
      // `agentSessionId`, both known here, so it starts alongside the two reads
      // below instead of after them. Only the final `computeConversationLabel`
      // needs the workspace title, and that is pure computation.
      //
      // Measured before this change: transcript 153ms -> turns+workspace 940ms
      // -> label 630ms, serialized into a ~1710ms handler. The enrichment query
      // was the whole of that last phase and overlaps the 940ms completely.
      const enrichmentPromise = timing.time("enrichment", async () => {
        try {
          const { fetchEnrichment } = await import("../conversation-label-enrichment");
          return await fetchEnrichment(db, [agentSessionId], await getOverviewTitleCache());
        } catch (enrichErr) {
          // Resolve to null rather than reject: a label is chrome, not data,
          // and the caller below falls back exactly as it did when the whole
          // block was one try/catch.
          const msg = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
          log.debug(`[conversation] label enrichment degraded: ${msg}`);
          return null;
        }
      });

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

      const [turnCount, workspace] = await timing.time("turns+workspace", () =>
        Promise.all([turnCountPromise, workspacePromise])
      );

      // mt#3343 — the page must be able to name ITSELF. Before this,
      // `/conversation/:id` derived its heading by searching the
      // context-inspector widget's top-50 picker window for its own id and fell
      // back to the raw uuid on a miss, which rendered the id as BOTH the
      // heading and the mono sub-line beneath it. The label is computed here,
      // server-side, because `custom/no-node-import-in-cockpit-web` bans value
      // imports from `@minsky/domain` in the browser bundle AND tiers 1/3 need
      // DB joins the browser cannot make.
      //
      // Tier 1 prefers the workspace overview's own resolved task title: this
      // route already built it, so reusing it costs nothing and stays correct
      // even if the `minsky_session_links` lookup inside `fetchEnrichment`
      // resolves a different (weaker) link.
      // Awaited BEFORE the `label` timer starts, not inside it (PR #2639 R1).
      // Awaiting it within the timed block would let any residual enrichment
      // wait land in `label`, so a phase whose whole point is to show that the
      // query left the critical path would quietly absorb the query again —
      // the metric would stop being able to report its own failure.
      const enrichmentMap = await enrichmentPromise;

      const label = await timing.time("label", async () => {
        try {
          const { EMPTY_ENRICHMENT } = await import("../conversation-label-enrichment");
          const { computeConversationLabel } = await import(
            "@minsky/domain/transcripts/conversation-label"
          );
          if (!enrichmentMap) throw new Error("enrichment unavailable");
          const enrichment = enrichmentMap.get(agentSessionId) ?? EMPTY_ENRICHMENT;
          return computeConversationLabel({
            agentSessionId,
            cwd: transcript.cwd,
            startedAt: transcript.startedAt instanceof Date ? transcript.startedAt : null,
            linkedTaskTitle: workspace?.session.taskTitle ?? enrichment.linkedTaskTitle,
            generatedTitle: transcript.title,
            firstUserText: enrichment.firstUserText,
            subagentDescriptor: enrichment.subagentDescriptor,
          });
        } catch (labelErr) {
          // A label is chrome, not data — never fail the overview over it. The
          // tier-4 fallback (timestamp·cwd·id-prefix) is still strictly more
          // identifying than the bare uuid this task exists to remove.
          const msg = labelErr instanceof Error ? labelErr.message : String(labelErr);
          log.debug(`[conversation] label computation degraded: ${msg}`);
          const { deriveFallbackLabel } = await import(
            "@minsky/domain/transcripts/conversation-label"
          );
          return deriveFallbackLabel(
            agentSessionId,
            transcript.cwd,
            transcript.startedAt instanceof Date ? transcript.startedAt : null
          );
        }
      });

      const payload: ConversationOverviewResponse = {
        agentSessionId,
        label,
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
          // mt#3656: two writers each held the tip, so one branch is being
          // silently orphaned. `checked: false` is NOT an all-clear — it means
          // this conversation was last ingested before the detector existed, so
          // nothing has looked yet. A renderer must not read the empty list as
          // "no divergence" without consulting `checked` first.
          writerDivergence: {
            checked: transcript.divergenceCheckedAt instanceof Date,
            divergentTips: transcript.divergentTipLeaves ?? [],
          },
        },
        workspace,
      };

      // Stored under the token computed BEFORE the expensive legs ran, not a
      // freshly-read one: re-reading here could pick up a row that changed
      // mid-handler and stamp this payload with a version it does not actually
      // represent, which would then be served as current until the ceiling
      // expired. Mirrors the snapshot route's "cache under the version the
      // response was built from" discipline.
      overviewCache.set(agentSessionId, cacheToken, payload, Date.now());

      res.json(payload);
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "conversations")) return;
      log.error(
        `[conversation] GET /api/conversation/:agentSessionId/overview — internal error: ${getLoggableErrorSummary(err)}`
      );
      res
        .status(500)
        .json({ error: "An internal error occurred while fetching the conversation overview." });
    }
  });
}
