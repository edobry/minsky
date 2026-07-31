/**
 * Cockpit context-inspector snapshot route (mt#2615 — extracted from
 * server.ts, mt#2023).
 *
 *   GET /api/cockpit/context-inspector/snapshot
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import {
  classifySnapshotMiss,
  looksLikeConversationId,
  withBoundedTimeout,
  WRONG_ID_SPACE_MESSAGE,
} from "../conversation-id-space";
import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";
import { getContextInspectorDb, getServerSessionProvider } from "../db-providers";

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
      const db = await getContextInspectorDb();
      if (db === null) {
        contextInspectorError(
          res,
          503,
          "unsupported_provider",
          "Context inspector requires a SQL persistence provider."
        );
        return;
      }

      const { assembleSessionContextSnapshot } = await import(
        "@minsky/domain/transcripts/session-context-snapshot"
      );
      // mt#3131 (D3): bound the assembly call itself — a DB pool under
      // contention must not hang this response forever.
      const snapshot = await withBoundedTimeout(
        assembleSessionContextSnapshot(db, sessionId as AgentSessionId),
        SNAPSHOT_ASSEMBLY_TIMEOUT_MS
      );

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

      res.json(snapshot);
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
