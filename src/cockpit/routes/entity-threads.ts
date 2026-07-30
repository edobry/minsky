/**
 * Cockpit entity discussion thread routes (mt#3364, parent mt#3363).
 *
 *   GET  /api/entity-thread/:entityType/:entityId          — the thread's turns,
 *                                                             projected to render blocks
 *   POST /api/entity-thread/:entityType/:entityId/message  — append the principal's
 *                                                             message and forward it to
 *                                                             the thread's agent
 *
 * LOCAL-DAEMON ONLY, for the same reason ./driven-sessions.ts is: a thread's
 * agent is a genuine `claude` binary spawned with the operator's own
 * credentials on the operator's own machine (the mt#2750 invariant). These
 * routes are not mounted for the public Railway entrypoint.
 *
 * `POST` already passes through `mutationAuthMiddleware` in ../server.ts.
 *
 * ## Scope boundary (mt#3364 vs its siblings)
 *
 * This module ships the ask mount only. Other entity types are REFUSED with an
 * explicit 400 rather than silently accepted, because each kind needs its own
 * seed adapter (see `askToEntitySeed`) and a thread seeded with an empty body
 * would produce an agent confidently discussing nothing. mt#3366 adds the
 * task / changeset / memory adapters and widens this check.
 *
 * The reply STREAM to the browser is not here either — that is the panel's
 * concern (mt#3365), which consumes the existing per-session driven WebSocket.
 * This module persists replies so the thread survives with or without a
 * connected browser; it does not push them.
 *
 * @see mt#3364 — this module
 * @see ../entity-thread-launch.ts — seeding, spawn, and reply capture
 * @see packages/domain/src/transcripts/entity-thread-store.ts — persistence
 */
import type express from "express";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import {
  appendEntityThreadTurn,
  getOrCreateEntityThread,
  listEntityThreadBlocks,
  type EntityThreadEntityType,
} from "@minsky/domain/transcripts/entity-thread-store";
import {
  askToEntitySeed,
  createEntityThreadReplyRecorder,
  startEntityThreadSession,
  type EntityThreadSession,
} from "../entity-thread-launch";
import { createCachedSqlDbGetter, getServerAskRepository } from "../db-providers";
import { sendDrivenSessionInput } from "../driven-session-host";

/**
 * Lazy-cached SQL handle. `cacheNegative: false` — a failed probe is retried on
 * the next request rather than latched, so a thread recovers on its own when
 * the database comes back instead of staying dead for the daemon's lifetime.
 */
const getEntityThreadDb = createCachedSqlDbGetter({ cacheNegative: false });

/** Entity kinds this module can seed today. See the docblock's scope boundary. */
const SUPPORTED_ENTITY_TYPES = new Set<EntityThreadEntityType>(["ask"]);

export interface EntityThreadRoutesOptions {
  /** Override the database handle (tests). */
  dbOverride?: PostgresJsDatabase | null;
  /** Override session start/lookup (tests avoid spawning a real binary). */
  startSession?: typeof startEntityThreadSession;
}

/**
 * Validate the `:entityType` path segment.
 *
 * Returns the narrowed type or an error STRING naming what IS supported —
 * a bare 400 would leave a caller guessing whether the type was wrong, the id
 * was wrong, or the feature is simply not built yet for their entity.
 */
export function parseEntityType(raw: unknown): EntityThreadEntityType | { error: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { error: "entityType is required" };
  }
  if (!SUPPORTED_ENTITY_TYPES.has(raw as EntityThreadEntityType)) {
    return {
      error: `entity threads are not yet available for '${raw}' — supported: ${[...SUPPORTED_ENTITY_TYPES].join(", ")}`,
    };
  }
  return raw as EntityThreadEntityType;
}

/** Validate a POST message body. */
export function parseMessageBody(body: unknown): { text: string } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const text = (body as Record<string, unknown>)["text"];
  if (typeof text !== "string") return { error: "text is required" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { error: "text must not be empty" };
  return { text: trimmed };
}

export function mountEntityThreadRoutes(
  app: express.Express,
  options: EntityThreadRoutesOptions = {}
): void {
  const startSession = options.startSession ?? startEntityThreadSession;

  app.get("/api/entity-thread/:entityType/:entityId", async (req, res) => {
    const entityType = parseEntityType(req.params["entityType"]);
    if (typeof entityType !== "string") {
      res.status(400).json({ error: entityType.error });
      return;
    }
    const entityId = req.params["entityId"];
    if (!entityId) {
      res.status(400).json({ error: "entityId is required" });
      return;
    }

    const db = options.dbOverride ?? (await getEntityThreadDb());
    if (!db) {
      // 503, not 500: a missing SQL provider is a transient environment
      // condition, and the panel should retry rather than render an error.
      res.status(503).json({ error: "entity-thread store unavailable" });
      return;
    }

    try {
      const thread = await getOrCreateEntityThread(db, { entityType, entityId });
      const blocks = await listEntityThreadBlocks(db, thread.localId);
      res.json({ ...thread, blocks });
    } catch (err) {
      log.error(`GET entity-thread failed for ${entityType}/${entityId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "failed to load thread" });
    }
  });

  app.post("/api/entity-thread/:entityType/:entityId/message", async (req, res) => {
    const entityType = parseEntityType(req.params["entityType"]);
    if (typeof entityType !== "string") {
      res.status(400).json({ error: entityType.error });
      return;
    }
    const entityId = req.params["entityId"];
    if (!entityId) {
      res.status(400).json({ error: "entityId is required" });
      return;
    }
    const parsed = parseMessageBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const db = options.dbOverride ?? (await getEntityThreadDb());
    if (!db) {
      res.status(503).json({ error: "entity-thread store unavailable" });
      return;
    }

    try {
      const thread = await getOrCreateEntityThread(db, { entityType, entityId });

      // Persist the principal's message BEFORE touching the agent. If the spawn
      // or the forward fails, the question is still in the thread — losing what
      // the operator typed is worse than a turn with no reply yet.
      const turn = await appendEntityThreadTurn(db, {
        localId: thread.localId,
        role: "operator",
        content: parsed.text,
      });

      const seed = await buildSeedForEntity(entityType, entityId);
      if (!seed) {
        res.status(404).json({ error: `${entityType} ${entityId} not found` });
        return;
      }

      let session: EntityThreadSession;
      try {
        session = startSession({ seed });
      } catch (err) {
        log.error(`entity-thread: failed to start session for ${thread.localId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // The turn is stored; the agent is not reachable. Say so rather than
        // returning 200 for a message no agent will ever see.
        res.status(502).json({ error: "could not start the thread's agent", turn });
        return;
      }

      if (session.spawned) {
        session.record.subscribers.add(createEntityThreadReplyRecorder(db, thread.localId));
      }

      const delivered = sendDrivenSessionInput(session.record, parsed.text);
      res.json({ turn, localId: thread.localId, seeded: session.seeded, delivered });
    } catch (err) {
      log.error(`POST entity-thread message failed for ${entityType}/${entityId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "failed to post message" });
    }
  });
}

/**
 * Fetch the entity and narrow it to a seed.
 *
 * Returns `null` when the entity does not exist, so the caller can answer 404
 * rather than seeding an agent with an empty body — an agent confidently
 * discussing a nonexistent ask is a worse failure than an honest 404.
 */
async function buildSeedForEntity(
  entityType: EntityThreadEntityType,
  entityId: string
): Promise<ReturnType<typeof askToEntitySeed> | null> {
  if (entityType === "ask") {
    const repo = await getServerAskRepository();
    if (!repo) return null;
    const ask = await repo.getById(entityId);
    if (!ask) return null;
    return askToEntitySeed({
      id: ask.id,
      shortId: ask.shortId ?? null,
      title: ask.title ?? null,
      question: ask.question,
      kind: ask.kind ?? null,
      parentTaskId: ask.parentTaskId ?? null,
      contextRefs: (ask.contextRefs ?? null) as { kind: string; ref: string }[] | null,
    });
  }
  // Unreachable while SUPPORTED_ENTITY_TYPES is ask-only; kept so mt#3366's
  // widening has an obvious place to add each adapter.
  return null;
}
