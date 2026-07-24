/**
 * Cockpit conversation run-state ingest (mt#3161, mt#3130 Phase 1).
 *
 *   POST /api/conversation-run-state — record one observed harness hook event
 *
 * ## Why the daemon owns this write
 *
 * The alternative was for the hook to write Postgres directly, the way
 * `record-subagent-invocation.ts` does. Measured from a cold hook process
 * (which is what the harness spawns per event): direct-to-Postgres costs
 * ~695ms, versus ~20ms for this POST. `SubagentStop` fires once per subagent
 * so it can afford the former; `PreToolUse` fires on every tool call in every
 * conversation in every dispatched-subagent workspace, so it cannot.
 *
 * ## This endpoint is NOT exempt from mutation auth
 *
 * `server.ts` installs `mutationAuthMiddleware` in front of every non-GET
 * request, so callers must present the cockpit bearer token. The writer hook
 * reads it from `~/.local/state/minsky/cockpit-token` (mode 0600) and sends it
 * as `Authorization: Bearer <token>`. Exempting this route would punch a
 * write-capable hole in the one middleware guarding every mutation, to save the
 * hook a file read — a bad trade against a deliberately same-origin posture.
 *
 * @see packages/domain/src/conversation-run-state/repository.ts
 * @see .minsky/hooks/record-conversation-run-state.ts — the writer
 */
import type express from "express";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { recordRunStateEvent } from "@minsky/domain/conversation-run-state/repository";
import { createCachedSqlDbGetter } from "../db-providers";

/**
 * Lazy-cached SQL handle. `cacheNegative: false` — a failed probe is retried on
 * the next request rather than latched permanently, because this endpoint runs
 * for the life of the daemon and must recover on its own when the database
 * comes back. (Contrast `getContextInspectorDb`, which latches.)
 */
const getRunStateDb = createCachedSqlDbGetter({ cacheNegative: false });

/** Options accepted by {@link mountConversationRunStateRoutes}. */
export interface ConversationRunStateRoutesOptions {
  /** Override the database handle (used in tests). */
  dbOverride?: PostgresJsDatabase | null;
}

/** Parsed, validated ingest request. */
interface ParsedIngestBody {
  conversationId: string;
  eventName: string;
  observedAt: Date;
  cwd: string | null;
  payload: Record<string, unknown>;
}

/**
 * Validate the ingest body. Returns an error STRING rather than throwing so the
 * route can answer 400 with a specific reason — a hook that starts sending a
 * malformed payload should be diagnosable from the daemon log, not silently
 * swallowed.
 *
 * `observedAt` is supplied by the caller (the hook stamps it at observation
 * time) and falls back to server-now only when absent or unparseable, so queue
 * or retry latency cannot backdate the liveness heartbeat.
 */
export function parseIngestBody(body: unknown): ParsedIngestBody | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;

  const conversationId = b["conversationId"];
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    return { error: "conversationId is required" };
  }

  const eventName = b["eventName"];
  if (typeof eventName !== "string" || eventName.length === 0) {
    return { error: "eventName is required" };
  }

  let observedAt = new Date();
  const rawObservedAt = b["observedAt"];
  if (typeof rawObservedAt === "string") {
    const parsed = new Date(rawObservedAt);
    if (!Number.isNaN(parsed.getTime())) observedAt = parsed;
  }

  const cwd = typeof b["cwd"] === "string" ? (b["cwd"] as string) : null;
  const rawPayload = b["payload"];
  const payload =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  return { conversationId, eventName, observedAt, cwd, payload };
}

/** Mount the conversation run-state routes on `app`. */
export function mountConversationRunStateRoutes(
  app: express.Express,
  options: ConversationRunStateRoutesOptions = {}
): void {
  app.post("/api/conversation-run-state", async (req, res) => {
    const parsed = parseIngestBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const db = options.dbOverride ?? (await getRunStateDb());
    if (!db) {
      // 503, not 500: the writer treats any non-2xx as "drop it and move on",
      // and a missing SQL provider is a transient environment condition rather
      // than a bad request.
      res.status(503).json({ error: "run-state store unavailable" });
      return;
    }

    try {
      const result = await recordRunStateEvent(db, {
        conversationId: parsed.conversationId,
        eventName: parsed.eventName,
        observedAt: parsed.observedAt,
        cwd: parsed.cwd,
        payload: parsed.payload,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}
