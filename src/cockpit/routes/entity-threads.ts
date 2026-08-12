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
 * This module ships the ask and task mounts (mt#3364, widened by mt#3366).
 * Other entity types are REFUSED with an explicit 400 rather than silently
 * accepted, because each kind needs its own seed adapter (see `askToEntitySeed`
 * / `taskToEntitySeed`) and a thread seeded with an empty body would produce an
 * agent confidently discussing nothing.
 *
 * Changeset and memory are deliberately NOT mounted — not merely unbuilt. A
 * changeset already has a review surface carrying more context than a thread
 * would, and no one has been able to state the question a memory thread
 * answers. See mt#3366's scope note. Adding either later is one adapter plus
 * one entry in `SUPPORTED_ENTITY_TYPES`.
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
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import {
  blocksToStoredAgentReplies,
  pendingReplyBuffer,
  shouldReportPendingReplies,
} from "../entity-thread-reply-buffer";
import { isDatabaseUnavailableError } from "@minsky/domain/persistence/postgres-retry";
import { describeServerPersistenceUnavailability } from "../db-providers";
import {
  ENTITY_THREAD_SUPPORTED_TYPES,
  formatSupportedEntityTypes,
  isEntityThreadSupportedType,
  type EntityThreadSupportedType,
} from "@minsky/shared/entity-thread-types";
import {
  appendEntityThreadTurn,
  entityThreadLocalId,
  findEntityThread,
  getOrCreateEntityThread,
  listEntityThreadBlocks,
  type EntityThreadEntityType,
} from "@minsky/domain/transcripts/entity-thread-store";
import {
  askToEntitySeed,
  createEntityThreadReplyRecorder,
  resolveOriginConversationId,
  startEntityThreadSession,
  taskToEntitySeed,
  type EntityThreadSession,
} from "../entity-thread-launch";
import {
  createCachedSqlDbGetter,
  getServerAskRepository,
  getServerTaskService,
} from "../db-providers";
import {
  drivenSessionRegistry,
  hasLiveActuator,
  sendDrivenSessionInput,
} from "../driven-session-host";

/**
 * Is an agent actually able to answer on this thread right now? (mt#3402)
 *
 * Derived from the registry, NOT from the thread's contents. Before this, the
 * panel inferred "the assistant is responding" from "the last turn is the
 * operator's" — which is also what a crashed, exited, or never-started agent
 * looks like, so a stranded thread claimed a reply was coming indefinitely.
 *
 * `hasLiveActuator` (not merely "a record exists") is the right predicate: a
 * record loaded by boot reconciliation sits in `reconnecting` with no process
 * behind it, and that cannot answer either.
 */
function isThreadAgentLive(localId: string, registry = drivenSessionRegistry): boolean {
  const record = registry.get(localId);
  return record !== undefined && hasLiveActuator(record);
}

/**
 * Why this thread's agent is not running, when that is knowable (mt#4037).
 *
 * `live: false` alone cannot distinguish "the cockpit restarted and killed it"
 * from "it exited on its own", and the panel has been telling the operator the
 * second one either way — "The agent stopped before answering", which blames
 * the agent for a daemon shutdown.
 *
 * `reconnecting` is exactly the durable evidence criterion 4 requires. Boot
 * reconciliation builds that record FROM the persisted `driven_sessions` row
 * (`driven-session-launch.ts`), for a row that was still non-terminal when the
 * daemon stopped writing — i.e. an actuator that was alive when the process
 * went away, rather than one that exited and wrote its own terminal status.
 * The claim therefore survives the restart that produced it; it is not
 * reconstructed from an in-memory registry the restart just cleared.
 *
 * Returns `undefined` — not a guess — whenever there is no record or the record
 * is in any other state. Absent means UNKNOWN, the same discipline `live` and
 * `originSeeded` follow, and the panel falls back to saying only what it can
 * support.
 */
export function deriveAgentStopReason(
  localId: string,
  registry = drivenSessionRegistry
): "cockpit-restart" | "unrecoverable" | undefined {
  const record = registry.get(localId);
  if (!record || hasLiveActuator(record)) return undefined;
  if (record.status === "reconnecting") return "cockpit-restart";
  if (record.status === "unrecoverable") return "unrecoverable";
  return undefined;
}

/**
 * Lazy-cached SQL handle. `cacheNegative: false` — a failed probe is retried on
 * the next request rather than latched, so a thread recovers on its own when
 * the database comes back instead of staying dead for the daemon's lifetime.
 */
const getEntityThreadDb = createCachedSqlDbGetter({ cacheNegative: false });

/**
 * The 503 body for both the missing-handle and wedged-pool cases (mt#3398).
 *
 * One string for both so the panel has a single thing to recognize, and so the
 * two paths cannot drift into saying different things about the same condition.
 * Names the DATABASE rather than the thread: the thread's turns are intact and
 * its agent may still be running, so "failed to load discussion" was actively
 * misleading — it read as "your thread is broken" during an incident where
 * nothing about the thread was.
 */
const DB_UNAVAILABLE_MESSAGE = "entity-thread store unavailable";

/**
 * The supported set is declared ONCE, in `@minsky/shared/entity-thread-types`,
 * and shared with the browser panel (PR #2467 R1 BLOCKING). It used to be a
 * local `Set` here plus a hand-written union in the panel, which could drift
 * silently and forced a panel edit on every widening.
 *
 * This assertion is the compile-time bridge to the PERSISTENCE type, which lives
 * in a Drizzle-importing module the browser cannot load. If a kind is ever added
 * to the shared list that the store cannot persist, this line fails to compile
 * rather than failing at the first INSERT.
 */
const _supportedTypesArePersistable: readonly EntityThreadEntityType[] =
  ENTITY_THREAD_SUPPORTED_TYPES;
void _supportedTypesArePersistable;

/**
 * Entity kinds for which an originating conversation can be resolved at all
 * (mt#3367).
 *
 * Only asks today: the lookup keys off `asks.parent_session_id`, and no other
 * entity kind carries an equivalent. A task's "origin" is a different notion
 * with different semantics — the original spec deliberately left it out of
 * scope rather than guessing at one.
 *
 * Exported so the reporting decision is directly testable, and separate from
 * `ENTITY_THREAD_SUPPORTED_TYPES` on purpose: a kind can have a thread without
 * having an origin (that is exactly the task case).
 */
export function supportsOriginSeeding(entityType: EntityThreadSupportedType): boolean {
  return entityType === "ask";
}

export interface EntityThreadRoutesOptions {
  /** Override the database handle (tests). */
  dbOverride?: PostgresJsDatabase | null;
  /** Override session start/lookup (tests avoid spawning a real binary). */
  startSession?: typeof startEntityThreadSession;
  /**
   * Override entity resolution (tests). Injectable so the
   * validate-before-write ordering below can be exercised without a live ask
   * repository — the ordering is the thing that must not regress.
   */
  loadSeed?: typeof buildSeedForEntity;
}

/**
 * Validate the `:entityType` path segment.
 *
 * Returns the narrowed type or an error STRING naming what IS supported —
 * a bare 400 would leave a caller guessing whether the type was wrong, the id
 * was wrong, or the feature is simply not built yet for their entity.
 */
export function parseEntityType(raw: unknown): EntityThreadSupportedType | { error: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { error: "entityType is required" };
  }
  if (!isEntityThreadSupportedType(raw)) {
    // Order comes from the shared declaration, so this message is stable
    // (PR #2467 R1 non-blocking) and can be asserted verbatim in tests.
    return {
      error: `entity threads are not yet available for '${raw}' — supported: ${formatSupportedEntityTypes()}`,
    };
  }
  return raw;
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
  const loadSeed = options.loadSeed ?? buildSeedForEntity;

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
      res.status(503).json({
        error: `${DB_UNAVAILABLE_MESSAGE} — ${await describeServerPersistenceUnavailability()}`,
      });
      return;
    }

    try {
      // The entity must exist before this route says anything about a thread
      // for it — otherwise a mistyped id renders as a real (empty) thread.
      const seed = await loadSeed(entityType, entityId, db);
      if (!seed) {
        res.status(404).json({ error: `${entityType} ${entityId} not found` });
        return;
      }

      // Read-only: a GET never creates a thread row. The panel polls this
      // endpoint, so creating here would mint a row for every glance at an
      // entity — and, before the existence check above, for every mistyped id.
      // `localId` is derived purely, so an unopened thread still has a stable
      // address to POST against.
      const existing = await findEntityThread(db, entityType, entityId);
      const localId = existing?.localId ?? entityThreadLocalId(entityType, entityId);
      const blocks = existing ? await listEntityThreadBlocks(db, localId) : [];
      // Reconciled against the blocks just read, not reported raw (PR #2913 R1
      // BLOCKING). In the commit-succeeded-but-ack-failed case the reply is
      // ALREADY in `blocks` while still sitting in the queue until the next
      // drain tick — reporting the queue as-is renders the reply and a notice
      // saying it could not be saved, in the same response. The route holds the
      // evidence to settle that, so it settles it here rather than waiting for
      // an async drain.
      const pendingReport = pendingReplyBuffer.report(localId, blocksToStoredAgentReplies(blocks));
      res.json({
        localId,
        entityType,
        entityId,
        blocks,
        // mt#3402: the panel cannot tell "thinking" from "dead" without this.
        live: isThreadAgentLive(localId),
        // mt#4037: WHY it is not live, when that is knowable from state the
        // restart could not erase. Omitted when unknown — see
        // `deriveAgentStopReason`.
        ...(() => {
          const stopReason = deriveAgentStopReason(localId);
          return stopReason ? { agentStopReason: stopReason } : {};
        })(),
        // mt#3367: whether the agent can reach the conversation that filed this
        // entity. Surfaced so the principal knows which grounding an answer has
        // — reachability is only ~46%, so "seeded" is not the safe assumption.
        //
        // OMITTED entirely for an entity kind that has no origin-seeding at all
        // (PR #2493 R1 BLOCKING). Reporting `false` for a task would render "the
        // originating conversation isn't reachable", which asserts a failed
        // lookup that never ran — the exact species of unfounded claim this task
        // exists to remove, just pointed at the principal instead of the agent.
        // Absent means UNKNOWN and the panel says nothing.
        ...(supportsOriginSeeding(entityType)
          ? { originSeeded: seed.originConversationId !== undefined }
          : {}),
        // mt#4036: replies the agent produced that could not be written. Without
        // this the panel renders a dropped reply as nothing at all, which reads
        // as "the agent never answered" — the 2026-08-11 failure.
        //
        // OMITTED when there is nothing to say, following `originSeeded`'s
        // discipline directly above: absent means "no unpersisted replies", and
        // a daemon predating this field says nothing rather than reporting a
        // reassuring zero it never actually checked.
        ...(shouldReportPendingReplies(pendingReport) ? { pendingReplies: pendingReport } : {}),
      });
    } catch (err) {
      // mt#3398: `err.message` on a Drizzle failure is the QUERY TEXT — the
      // Postgres cause sits in `err.cause` and was being discarded, which is why
      // diagnosing the 2026-07-30 incident required inferring the cause from
      // which tables happened to be failing.
      log.error(`GET entity-thread failed for ${entityType}/${entityId}`, {
        error: getLoggableErrorSummary(err),
      });
      if (isDatabaseUnavailableError(err)) {
        // Same 503 the missing-handle branch above already returns — a wedged
        // pool is the same transient environment condition, and the panel keeps
        // polling through it instead of presenting a dead thread.
        res.status(503).json({
          error: `${DB_UNAVAILABLE_MESSAGE} — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
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
      res.status(503).json({
        error: `${DB_UNAVAILABLE_MESSAGE} — ${await describeServerPersistenceUnavailability()}`,
      });
      return;
    }

    try {
      // Resolve the entity FIRST. Every write below is conditional on it
      // existing: creating the thread or storing the turn before this check
      // leaves orphan rows keyed to an entity that was never there, and no
      // later failure path can retract them (PR #2427 R1 BLOCKING).
      const seed = await loadSeed(entityType, entityId, db);
      if (!seed) {
        res.status(404).json({ error: `${entityType} ${entityId} not found` });
        return;
      }

      const thread = await getOrCreateEntityThread(db, { entityType, entityId });

      // Persist the principal's message BEFORE touching the agent. If the spawn
      // or the forward fails, the question is still in the thread — losing what
      // the operator typed is worse than a turn with no reply yet. This stays
      // AFTER the existence check above and BEFORE the spawn below; both
      // orderings are load-bearing.
      const turn = await appendEntityThreadTurn(db, {
        localId: thread.localId,
        role: "operator",
        content: parsed.text,
      });

      let session: EntityThreadSession;
      try {
        session = await startSession({ seed });
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
        error: getLoggableErrorSummary(err),
      });
      if (isDatabaseUnavailableError(err)) {
        res.status(503).json({
          error: `${DB_UNAVAILABLE_MESSAGE} — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
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
  entityId: string,
  db?: PostgresJsDatabase | null
): Promise<ReturnType<typeof askToEntitySeed> | null> {
  if (entityType === "task") {
    const taskService = await getServerTaskService();
    if (!taskService) return null;
    const task = await taskService.getTask(entityId);
    if (!task) return null;
    // `getTask` does not populate `spec` on every backend, so fetch the body
    // separately and tolerate its absence — a task with no readable spec is
    // still a real task, and `taskToEntitySeed` names the gap rather than
    // seeding an empty body.
    let spec: string | null = task.spec ?? null;
    if (!spec) {
      try {
        spec = (await taskService.getTaskSpecContent(entityId)).content;
      } catch (err) {
        // Not fatal: log it rather than swallowing, then seed without the body.
        log.warn(`entity-thread: no spec content for task ${entityId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return taskToEntitySeed({
      id: task.id,
      title: task.title ?? null,
      status: task.status ?? null,
      kind: task.kind ?? null,
      parentTaskId: task.parentTaskId ?? null,
      spec,
      tags: task.tags ?? null,
    });
  }

  if (entityType === "ask") {
    const repo = await getServerAskRepository();
    if (!repo) return null;
    const ask = await repo.getById(entityId);
    if (!ask) return null;
    // mt#3367 — the conversation that filed this ask, when reachable. Resolved
    // here rather than inside the adapter so the adapter stays pure and
    // unit-testable with no database. Degrades to null on any failure; the
    // prompt then SAYS the origin is unavailable rather than omitting it.
    const originConversationId = db
      ? await resolveOriginConversationId(db, ask.parentSessionId ?? null)
      : null;

    return askToEntitySeed({
      id: ask.id,
      shortId: ask.shortId ?? null,
      title: ask.title ?? null,
      question: ask.question,
      kind: ask.kind ?? null,
      parentTaskId: ask.parentTaskId ?? null,
      contextRefs: (ask.contextRefs ?? null) as { kind: string; ref: string }[] | null,
      originConversationId,
    });
  }
  // Unreachable while SUPPORTED_ENTITY_TYPES is ask-only; kept so mt#3366's
  // widening has an obvious place to add each adapter.
  return null;
}
