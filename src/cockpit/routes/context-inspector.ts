/**
 * Cockpit context-inspector snapshot route (mt#2615 — extracted from
 * server.ts, mt#2023).
 *
 *   GET /api/cockpit/context-inspector/snapshot
 */
import type express from "express";
import { sql } from "drizzle-orm";
import { log } from "@minsky/shared/logger";
import {
  classifySnapshotMiss,
  looksLikeConversationId,
  withBoundedTimeout,
  WRONG_ID_SPACE_MESSAGE,
} from "../conversation-id-space";
import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";
import { getContextInspectorDb, getServerSessionProvider } from "../db-providers";
import { ServerTimingRecorder } from "../server-timing";
import { SnapshotCache, snapshotEtag } from "../snapshot-cache";
import { sendJsonMaybeCompressed } from "../compressed-json";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Assembled snapshots, keyed by conversation and validated by version token
 * (mt#4258). Module-scoped so it is shared across requests — that sharing IS
 * the mechanism; a per-request cache would be a no-op.
 */
const snapshotCache = new SnapshotCache();

/**
 * A token identifying the current state of one conversation's stored rows.
 *
 * Returns `null` when the conversation has no `agent_transcripts` row — the
 * caller then skips caching entirely rather than caching under a token that
 * says nothing.
 *
 * ## What it counts, and the one case it cannot see
 *
 * Turn count and attachment count both change whenever the conversation gains
 * content, which is the case this exists for. `ended_at` is included so a
 * conversation transitioning to finished re-assembles rather than serving the
 * mid-flight copy.
 *
 * The gap, stated plainly: a REWIND that replaces turns while leaving the count
 * and `ended_at` identical produces the same token. That is not a silent bet —
 * the conversation view merges this snapshot with a live SSE tail, so an active
 * conversation's newest turns arrive on that channel regardless, and the window
 * where this could matter is one poll interval on a conversation being actively
 * rewound. Sizing the token to catch it would mean hashing the whole 7.5 MB
 * jsonb, which is the exact cost this probe exists to avoid.
 */
async function readSnapshotVersion(
  db: PostgresJsDatabase,
  agentSessionId: AgentSessionId
): Promise<string | null> {
  const rows = await db.execute<{
    turns: number | null;
    attachments: string | number | null;
    ended_at: Date | string | null;
  }>(sql`
    select
      jsonb_array_length(t.transcript) as turns,
      t.ended_at as ended_at,
      (
        select count(*)
        from agent_transcript_attachments a
        where a.agent_session_id = t.agent_session_id
      ) as attachments
    from agent_transcripts t
    where t.agent_session_id = ${agentSessionId}
    limit 1
  `);

  const row = rows[0];
  if (row === undefined) return null;

  const endedAt =
    row.ended_at instanceof Date ? row.ended_at.toISOString() : (row.ended_at ?? "live");
  return `${row.turns ?? 0}-${row.attachments ?? 0}-${endedAt}`;
}

// Stable user-safe error codes for the snapshot endpoint (PR #1230 R1 BLOCKING).
// Mirrors the credential-endpoint sanitization discipline: raw `err.message`
// values are logged server-side via `log.error` but NEVER returned to the
// client.
type ContextInspectorErrorCode =
  | "missing_field"
  | "unsupported_provider"
  | "session_not_found"
  | "wrong_id_space"
  | "invalid_id"
  | "internal";

/**
 * Bound for the full snapshot-assembly call (mt#3131 D3) — a DB query under
 * contention (e.g. a live conversation's own polling load) must not leave
 * this route's response pending indefinitely. Generous relative to
 * `SNAPSHOT_MISS_PROBE_TIMEOUT_MS` (5s) because a legitimate large-transcript
 * assembly does real, non-trivial work.
 */
const SNAPSHOT_ASSEMBLY_TIMEOUT_MS = 15_000;

function contextInspectorError(
  res: express.Response,
  status: number,
  code: ContextInspectorErrorCode,
  message: string
): void {
  res.status(status).json({ error: { code, message } });
}

function logContextInspectorInternal(route: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log.error(`[context-inspector] ${route} — internal error: ${detail}`);
}

/** Mount /api/cockpit/context-inspector/snapshot on `app`. */
export function mountContextInspectorRoutes(app: express.Express): void {
  /**
   * GET /api/cockpit/context-inspector/snapshot — fetch full SessionContextSnapshot
   * for a given agent session (mt#2023).
   *
   * Query params:
   *   ?sessionId=<agent_session_id>   — required; the harness-native session UUID.
   *
   * Response: SessionContextSnapshot JSON (categorized chronological block list);
   *   404 `session_not_found` when no transcript exists for a syntactically
   *   plausible id; 404 `invalid_id` when the id isn't even UUID-shaped and so
   *   could never resolve (mt#3131 D3/D5 — rejected before any DB/provider
   *   call, distinguishing "not found" from "not yet ingested" for the
   *   client); or 422 `wrong_id_space` when the id is actually a Minsky
   *   WORKSPACE session id (not a harness conversation id) — the mt#2420 /
   *   mt#2525 fail-loud branch, so a misrouted id surfaces a clear error
   *   instead of "no transcript yet".
   *
   * The widget framework's single-payload shape doesn't fit the interactive
   * picker → detail pattern, so this endpoint lives as a sibling to the
   * `context-inspector` widget (which returns the picker source). The widget
   * + this endpoint together compose the "Context" tab.
   *
   * @see mt#2023 — this endpoint
   * @see mt#2022 — `assembleSessionContextSnapshot` from the foundation
   * @see mt#2033 — canonical SessionContextSnapshot shape
   */
  app.get("/api/cockpit/context-inspector/snapshot", async (req, res) => {
    // Attribute this route's server-side phases (mt#4258). `attachTo` rather
    // than per-exit `applyTo` so the 404/422/503/500 exits carry the header
    // too — a slow FAILURE is exactly what someone reaches for this header to
    // explain (mt#3696, PR #2637 R1). Until now this endpoint emitted no
    // Server-Timing at all, so its ~2s was one opaque number and the split
    // between round trips and payload transfer could only be inferred.
    const timing = new ServerTimingRecorder();
    timing.attachTo(res);

    const sessionId = req.query["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      contextInspectorError(res, 400, "missing_field", "`sessionId` is required.");
      return;
    }

    // mt#3131 (D3/D5): a syntactically-invalid conversation id can NEVER
    // resolve — reject immediately, before any DB query or provider probe.
    // Zero I/O, so this can never be the hang site, and it lets the client
    // (ConversationView) render "not found" instead of the misleading
    // "may still be running" copy that only makes sense for a plausible id.
    if (!looksLikeConversationId(sessionId)) {
      contextInspectorError(
        res,
        404,
        "invalid_id",
        `"${sessionId}" is not a valid conversation id.`
      );
      return;
    }

    try {
      // Lazy-cached SQL DB connection — mirrors the agents.ts singleton
      // pattern. Avoids constructing a fresh `PersistenceService` (and
      // re-initializing the provider) on every request. PR #1230 R1
      // non-blocking finding.
      const db = await timing.time("db", () => getContextInspectorDb());
      if (db === null) {
        contextInspectorError(
          res,
          503,
          "unsupported_provider",
          "Context inspector requires a SQL persistence provider."
        );
        return;
      }

      // Cheap validity probe (mt#4258). Two aggregates over rows already keyed
      // by this id, returning three scalars — versus the ~874ms the assembly
      // costs to pull 7.5 MB of jsonb over the wire. A token MISMATCH means the
      // conversation changed and we must re-assemble; a match means the cached
      // snapshot is still exactly what assembly would produce.
      //
      // Deliberately NOT a TTL: a live conversation gains turns continuously, so
      // any time-based cache silently serves a transcript missing its newest
      // turns. `agent_transcripts` carries no `updated_at`, so the token is
      // derived from what actually changes when the conversation does.
      const version = await timing.time("version", () =>
        readSnapshotVersion(db, sessionId as AgentSessionId)
      );

      if (version !== null) {
        // The ETag is deliberately ENCODING-AGNOSTIC (PR #3104 R1, non-blocking).
        // It identifies the snapshot's semantic content, so the identity and
        // gzip renderings of one version share a validator. That is what a WEAK
        // validator asserts, and it is correct here — but it has a visible
        // consequence worth stating: a client can be issued a 304 and then, on
        // its next unconditional request, negotiate a different encoding and see
        // a very differently sized transfer. Nothing is stale; only the size
        // changes. `sendJsonMaybeCompressed` sets `Vary: Accept-Encoding`, which
        // is what keeps a shared cache from serving one encoding's bytes to a
        // client that asked for the other. A per-encoding validator would need a
        // STRONG etag, which would in turn have to change whenever the
        // compression level did — a worse trade for a route whose client is the
        // cockpit SPA.
        const etag = snapshotEtag(version);
        res.setHeader("ETag", etag);

        // Revalidation: the client already holds this exact snapshot, so send
        // no body at all. This is the only path that avoids BOTH the assembly
        // and the multi-megabyte transfer.
        if (req.headers["if-none-match"] === etag) {
          timing.record("revalidated", 0, "304");
          timing.applyTo(res);
          res.status(304).end();
          return;
        }

        const cached = snapshotCache.get(sessionId, version);
        if (cached !== undefined) {
          timing.record("cache", 0, `hit ${cached.blocks.length} blocks`);
          await sendJsonMaybeCompressed(res, cached, {
            acceptEncoding: req.headers["accept-encoding"],
          });
          return;
        }
      }

      const { assembleSessionContextSnapshot } = await import(
        "@minsky/domain/transcripts/session-context-snapshot"
      );
      // mt#3131 (D3): bound the assembly call itself — a DB pool under
      // contention must not hang this response forever.
      const snapshot = await timing.time("assemble", () =>
        withBoundedTimeout(
          assembleSessionContextSnapshot(db, sessionId as AgentSessionId),
          SNAPSHOT_ASSEMBLY_TIMEOUT_MS
        )
      );
      if (snapshot !== null) {
        // Block count is the size driver this route's latency tracks, and it is
        // not recoverable from the header's durations alone — a 2s assemble over
        // 2,300 blocks and a 2s assemble over 12 are different findings.
        timing.record("blocks", 0, `${snapshot.blocks.length} blocks`);
        // Only cacheable when the probe produced a token to validate against;
        // without one there is no way to know later whether it went stale.
        if (version !== null) snapshotCache.set(sessionId, version, snapshot);
      }

      if (snapshot === null) {
        // Fail LOUD on the mt#2420 id-space mistake: a Minsky WORKSPACE id
        // (from /agents rows) passed where a harness CONVERSATION id is
        // expected. Probe the workspace substrate only on this miss path (no
        // happy-path cost); a distinct 422 beats the misleading 404
        // "no transcript yet" that ConversationView would otherwise render.
        const missClass = await classifySnapshotMiss(sessionId, async (id) => {
          const provider = await getServerSessionProvider();
          if (!provider) return false;
          return Boolean(await provider.getSession(id));
        });
        if (missClass === "wrong_id_space") {
          contextInspectorError(res, 422, "wrong_id_space", WRONG_ID_SPACE_MESSAGE);
          return;
        }
        contextInspectorError(
          res,
          404,
          "session_not_found",
          "No transcript found for the requested session."
        );
        return;
      }

      await sendJsonMaybeCompressed(res, snapshot, {
        acceptEncoding: req.headers["accept-encoding"],
      });
    } catch (err) {
      logContextInspectorInternal("GET /api/cockpit/context-inspector/snapshot", err);
      contextInspectorError(
        res,
        500,
        "internal",
        "An internal error occurred while assembling the snapshot."
      );
    }
  });
}
