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
  schedulePendingDrain,
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
import { raceAgainstTimeout } from "@minsky/shared/timeout";
import {
  appendEntityThreadTurn,
  entityThreadLocalId,
  findEntityThread,
  getOrCreateEntityThread,
  listEntityThreadTurns,
  turnToSnapshotBlock,
  recordEntityThreadConversationSwap,
  type EntityThreadEntityType,
} from "@minsky/domain/transcripts/entity-thread-store";
import { getDrivenSessionRecord } from "@minsky/domain/transcripts/driven-session-registry-store";
import {
  reconcileThreadFromTranscript,
  reconcileAllThreadsFromTranscript,
} from "../entity-thread-transcript-reconciler";
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
  hasLiveSessionDriver,
  sendDrivenSessionInput,
  type DrivenSessionRegistry,
} from "../driven-session-host";

/**
 * Is an agent actually able to answer on this thread right now? (mt#3402)
 *
 * Derived from the registry, NOT from the thread's contents. Before this, the
 * panel inferred "the assistant is responding" from "the last turn is the
 * operator's" — which is also what a crashed, exited, or never-started agent
 * looks like, so a stranded thread claimed a reply was coming indefinitely.
 *
 * `hasLiveSessionDriver` (not merely "a record exists") is the right predicate: a
 * record loaded by boot reconciliation sits in `reconnecting` with no process
 * behind it, and that cannot answer either.
 */
function isThreadAgentLive(localId: string, registry = drivenSessionRegistry): boolean {
  const record = registry.get(localId);
  return record !== undefined && hasLiveSessionDriver(record);
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
 * daemon stopped writing — i.e. a session driver that was alive when the process
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
  if (!record || hasLiveSessionDriver(record)) return undefined;
  if (record.status === "reconnecting") return "cockpit-restart";
  if (record.status === "unrecoverable") return "unrecoverable";
  return undefined;
}

/**
 * {@link deriveAgentStopReason}, falling back to the PERSISTED row when the
 * registry holds no record at all (mt#4093).
 *
 * The registry-only form above says nothing in exactly the case mt#4093 is
 * about: an ABSENT record. Boot reconciliation loads only rows whose status is
 * non-terminal, and it may not have run at all, so "no record" is routine after
 * a restart — and it renders identically to a thread that never had an agent.
 * The operator then sees a dead thread with no explanation, which is the same
 * silence in a different surface.
 *
 * The persisted row settles it, and reading it is honest rather than a guess: a
 * row that exists and names a conversation IS resumable (the next message
 * resumes it — see `startEntityThreadSession`), which is precisely what
 * `cockpit-restart` already means to the panel. A row already marked
 * `unrecoverable` reports that instead.
 *
 * Degrades to the registry answer on any read failure. A thread that renders
 * without the reason is strictly better than a poll that 500s.
 */
export async function deriveAgentStopReasonWithPersisted(
  localId: string,
  db: PostgresJsDatabase,
  deps: {
    registry?: DrivenSessionRegistry;
    getPersisted?: typeof getDrivenSessionRecord;
  } = {}
): Promise<"cockpit-restart" | "unrecoverable" | undefined> {
  const registry = deps.registry ?? drivenSessionRegistry;
  const fromRegistry = deriveAgentStopReason(localId, registry);
  if (fromRegistry) return fromRegistry;
  // Only the ABSENT case falls through to the store. A record that exists and
  // reports a live session driver, or a terminal state this function deliberately
  // does not name, has already been answered by the registry — re-deriving it
  // from a row the registry's own record was built from could only disagree.
  if (registry.get(localId)) return undefined;

  const row = await (deps.getPersisted ?? getDrivenSessionRecord)(db, localId);
  if (!row) return undefined;
  if (row.status === "unrecoverable") return "unrecoverable";
  return row.harnessSessionId ? "cockpit-restart" : undefined;
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

/**
 * Bound for resolving the db handle when arming boot work (mt#4133).
 *
 * Deliberately the SAME value as `driven-session-launch.ts`'s
 * `RECONCILE_STAGE_TIMEOUT_MS` — the same handle, against the same database, at the same
 * moment in the same daemon's boot. mt#4103 picked it for that operation; a second,
 * differently-tuned number for the identical wait would be a distinction with no cause behind
 * it, and would drift.
 */
const ARM_DB_TIMEOUT_MS = 15_000;

/** What arming the entity-thread boot work actually did. See {@link armEntityThreadBootWork}. */
export type EntityThreadArmOutcome =
  | { kind: "armed" }
  | { kind: "no-persistence" }
  | { kind: "timed-out"; timeoutMs: number }
  | { kind: "failed"; error: string };

/** Injection seams for {@link armEntityThreadBootWork}. Production passes none. */
export interface ArmEntityThreadBootWorkDeps {
  getDb?: () => Promise<Awaited<ReturnType<typeof getEntityThreadDb>>>;
  timeoutMs?: number;
  timeoutSignal?: (ms: number) => Promise<{ timedOut: true }>;
}

/**
 * Arm the two pieces of boot work this module owns — the pending-reply drain and the
 * transcript reconcile — and RETURN what happened rather than logging it (mt#4133).
 *
 * The bound is the point. This previously did a bare `await getEntityThreadDb()`, so a handle
 * that never settled left neither branch of the `if (db)` reachable: no drain, no reconcile, no
 * error, and no log line — the daemon simply never did this work and nothing said so. That is
 * the shape mt#4103 found next door in `loadPersistedDrivenSessions`, where an unsettled await
 * left the driven-session registry empty for a daemon's entire life.
 *
 * Returning an outcome instead of logging is what makes the stall branch testable: a caller can
 * assert on `{ kind: "timed-out" }` directly, with an injected `timeoutSignal` that resolves
 * immediately, instead of capturing the logger or waiting out a real 15 seconds.
 */
export async function armEntityThreadBootWork(
  deps: ArmEntityThreadBootWorkDeps = {}
): Promise<EntityThreadArmOutcome> {
  const timeoutMs = deps.timeoutMs ?? ARM_DB_TIMEOUT_MS;
  try {
    const dbResult = await raceAgainstTimeout(
      (deps.getDb ?? getEntityThreadDb)(),
      timeoutMs,
      deps.timeoutSignal
    );
    if (dbResult.timedOut) {
      return { kind: "timed-out", timeoutMs };
    }
    const db = dbResult.value;
    if (!db) {
      return { kind: "no-persistence" };
    }

    schedulePendingDrain(db);
    // The buffer above is empty at boot BY CONSTRUCTION — that is the whole defect (mt#4073).
    // A reply the previous process buffered and never landed is gone from memory, but not from
    // the harness transcript the watcher ingests, so this is where it comes back. Boot is the
    // pass immediately following the restart that lost it.
    //
    // Deferred off the mount path rather than awaited in it (PR #2971 R1). It walks every thread
    // and queries the transcript per conversation, so running it inline puts an unbounded read
    // between the daemon starting and its routes being useful, and couples startup to the
    // store's health for no benefit — nothing about the recovery is more correct for having
    // happened a second earlier. `unref` so a pending timer cannot hold the process open at
    // shutdown, matching `schedulePendingDrain`'s own timer.
    setTimeout(() => {
      void reconcileAllThreadsFromTranscript(db);
    }, 0).unref?.();

    return { kind: "armed" };
  } catch (err) {
    return { kind: "failed", error: getLoggableErrorSummary(err) };
  }
}

/**
 * The line to emit for an arm outcome, or `null` when this outcome speaks for itself.
 *
 * `armed` returns null ON PURPOSE: `reconcileAllThreadsFromTranscript` logs its own unconditional
 * outcome line moments later (`entity-thread reconcile: scanned N thread(s) at boot…`), so a
 * second line here would report the same successful boot twice. Every other outcome means that
 * line will never be written, which is exactly why they need one of their own.
 *
 * The exhaustive switch is load-bearing: a new outcome kind added without a case fails the
 * `never` check at compile time rather than silently boot-ing with nothing logged — the failure
 * this whole task exists to remove.
 */
export function describeEntityThreadArmOutcome(
  outcome: EntityThreadArmOutcome
): { level: "info" | "warn"; message: string } | null {
  switch (outcome.kind) {
    case "armed":
      return null;
    case "no-persistence":
      return {
        level: "warn",
        message:
          "entity-thread boot: no database at start — pending-reply drain and transcript " +
          "reconcile were both skipped this boot",
      };
    case "timed-out":
      return {
        level: "warn",
        message:
          `entity-thread boot: resolving the database exceeded ${outcome.timeoutMs}ms — ` +
          "pending-reply drain and transcript reconcile were both skipped this boot",
      };
    case "failed":
      return {
        level: "warn",
        message: `entity-thread boot: could not arm boot work at start: ${outcome.error}`,
      };
    default: {
      // Compile-time exhaustiveness: a new outcome kind added without a case fails HERE.
      const exhaustive: never = outcome;
      // ...and a runtime line, because `never` is a compile-time guarantee only. A value built
      // by an older or newer build of a caller still arrives here, and returning `outcome`
      // itself would hand the mount site something that is not `{ level, message }` — so
      // `log[level](message)` would throw inside a fire-and-forget IIFE, i.e. exactly the
      // boot-time crash the mount-site comment promises cannot happen. Matches the house
      // convention (`pr-watch/watcher.ts`, `pr-drive-command.ts`): the fallback returns a valid
      // value of the declared type rather than the unexpected input. `String(kind)` rather than
      // `JSON.stringify` so a circular object cannot throw on the way to reporting itself.
      const kind = (exhaustive as { kind?: unknown }).kind;
      return {
        level: "warn",
        message: `entity-thread boot: unrecognized arm outcome ${String(kind)}`,
      };
    }
  }
}

export function mountEntityThreadRoutes(
  app: express.Express,
  options: EntityThreadRoutesOptions = {}
): void {
  const startSession = options.startSession ?? startEntityThreadSession;
  const loadSeed = options.loadSeed ?? buildSeedForEntity;

  // Arm the drain at daemon start (mt#4066, PR #2940 R1), completing the
  // invariant the route-level arm below only holds while someone is looking:
  // a non-empty buffer always has a live drain, checked at every point where
  // the buffer can be observed to have entries.
  //
  // Today this is a no-op and the comment is the point: the buffer is process
  // memory (mt#4036's docblock: "a restart loses it"), so at start it is
  // ALWAYS empty and `schedulePendingDrain` returns on its own empty-buffer
  // guard. It is here because that is a property of the CURRENT storage
  // choice, not of the invariant — the moment buffered replies survive a
  // restart (mt#4037's unshipped half), boot is exactly when a queue exists
  // with no chain behind it, and a fix that has to be remembered THEN is a
  // fix that will not be. Deliberately fire-and-forget: a db that cannot be
  // resolved at boot is the normal degraded start, not an error to raise.
  // Still fire-and-forget, and still never throws — `armEntityThreadBootWork` converts every
  // failure into a returned outcome, so an unhandled rejection cannot escape here and surface
  // as a boot-time crash (or, in tests, as an unhandled rejection in every suite that mounts
  // these routes).
  //
  // What changed (mt#4133): the degraded outcomes are no longer silent. They used to log at
  // `debug` — below the default level, so a boot that skipped this work said nothing an operator
  // would see — and the never-settling handle did not even reach that, because the bare `await`
  // it replaced had no bound at all.
  void (async () => {
    const described = describeEntityThreadArmOutcome(await armEntityThreadBootWork());
    // `log[level]` rather than a branch per kind, so a future outcome cannot be added with no
    // line at all: the describer owns the level, and this call site owns nothing it could
    // forget. Mirrors `loadPersistedDrivenSessions` (mt#4103).
    if (described) {
      log[described.level](described.message);
    }
  })();

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
      // Turns rather than blocks (mt#4073): the recovered-turn columns live on
      // the turn and are erased by the block projection, and the response has to
      // report them. `listEntityThreadBlocks` is exactly this map, so nothing is
      // duplicated — only the intermediate value is kept.
      let turns = existing ? await listEntityThreadTurns(db, localId) : [];
      let blocks = turns.map(turnToSnapshotBlock);
      // Reconciled against the blocks just read, not reported raw (PR #2913 R1
      // BLOCKING). In the commit-succeeded-but-ack-failed case the reply is
      // ALREADY in `blocks` while still sitting in the queue until the next
      // drain tick — reporting the queue as-is renders the reply and a notice
      // saying it could not be saved, in the same response. The route holds the
      // evidence to settle that, so it settles it here rather than waiting for
      // an async drain.
      const pendingReport = pendingReplyBuffer.report(localId, blocksToStoredAgentReplies(blocks));
      // Liveness backstop (mt#4066). The drain chain is armed ONLY by a failed
      // append and re-armed only by its own `.finally`, so a chain that ever
      // stops with entries still queued waits for the next UNRELATED failed
      // append to restart it. From the panel a reply nobody is retrying looks
      // exactly like one that is — the notice says "retrying" either way — so
      // the cheapest place to close that gap is the poll that renders it.
      // `schedulePendingDrain` returns immediately when a timer is already
      // armed or the buffer is empty, so the steady-state cost is a map walk,
      // and a thread being polled is precisely when someone is waiting.
      if (pendingReport.pending > 0) schedulePendingDrain(db);
      // The buffer gave up on a reply (mt#4066 ages one out after 15 minutes)
      // without the daemon ever restarting, so the boot pass has not run since
      // it was lost. The transcript may hold it — this is the one poll where
      // the cost is warranted, because a `lost` count is positive evidence of a
      // gap rather than a speculative scan on every poll of every thread.
      if (pendingReport.lost > 0) {
        const outcome = await reconcileThreadFromTranscript(db, localId);
        // Re-read rather than letting the recovery surface on the NEXT poll:
        // this response is the one the operator is looking at, and reporting a
        // recovery whose turn is not in `blocks` would render the notice above
        // an absent reply — the mirror of the PR #2913 R1 defect the pending
        // report was reconciled to avoid.
        if (outcome.recovered > 0) {
          turns = await listEntityThreadTurns(db, localId);
          blocks = turns.map(turnToSnapshotBlock);
        }
      }
      const recoveredTurns = turns.filter((turn) => turn.recoveredFromConversationId);
      // Awaited before the body is assembled (mt#4093) — the persisted-row
      // fallback is async, and an inline IIFE in the object literal would
      // have serialized a Promise into the response.
      const stopReason = await deriveAgentStopReasonWithPersisted(localId, db);
      res.json({
        localId,
        entityType,
        entityId,
        blocks,
        // mt#3402: the panel cannot tell "thinking" from "dead" without this.
        live: isThreadAgentLive(localId),
        // mt#4037: WHY it is not live, when that is knowable from state the
        // restart could not erase. Omitted when unknown — see
        // `deriveAgentStopReason`. mt#4093 extends it to the ABSENT-record
        // case, where the registry alone could only say nothing.
        ...(stopReason ? { agentStopReason: stopReason } : {}),
        // mt#4093: the conversation a fresh seeded agent replaced, when one
        // was. Every block above the swap belongs to it and the agent now
        // answering has never seen any of them — unsaid, the panel renders
        // continuity that does not exist, which is the whole defect. Omitted
        // when nothing was replaced, following `originSeeded`'s discipline
        // directly below: absent means "no swap on record", and a daemon
        // predating this column says nothing rather than reporting a
        // reassuring absence it never actually checked.
        // mt#4073: replies restored from the harness transcript after the
        // in-memory buffer died with a daemon restart. They append at the TAIL
        // (`seq` is allocated `MAX(seq)+1`) while carrying their ORIGINAL
        // timestamp, so without this the panel shows a reply sitting out of
        // order with an old time and no explanation. Omitted when nothing was
        // recovered, following `conversationSwap` directly below: absent means
        // "nothing to report", never a reassuring zero.
        ...(recoveredTurns.length > 0
          ? {
              recoveredReplies: {
                count: recoveredTurns.length,
                oldestOriginallySentAt: recoveredTurns
                  .map((turn) => turn.originallySentAt ?? turn.createdAt)
                  .reduce((oldest, at) => (at < oldest ? at : oldest))
                  .toISOString(),
              },
            }
          : {}),
        ...(existing?.replacedConversationId
          ? {
              conversationSwap: {
                replacedConversationId: existing.replacedConversationId,
                ...(existing.replacedAt ? { replacedAt: existing.replacedAt.toISOString() } : {}),
              },
            }
          : {}),
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
          error: getLoggableErrorSummary(err),
        });
        // The turn is stored; the agent is not reachable. Say so rather than
        // returning 200 for a message no agent will ever see.
        res.status(502).json({ error: "could not start the thread's agent", turn });
        return;
      }

      if (session.spawned) {
        session.record.subscribers.add(createEntityThreadReplyRecorder(db, thread.localId));
      }

      // mt#4093: persisted BEFORE the response, because this is the only moment
      // the outgoing conversation id exists anywhere Minsky can read — the
      // spawn that just happened upserted `driven_sessions` on this same
      // `localId`, overwriting `harness_session_id` with the new conversation.
      // Awaited rather than fire-and-forget so the very next poll, which the
      // panel issues immediately, already sees the swap; the writer swallows
      // its own failures, so this cannot fail the message.
      if (session.replacedConversationId) {
        await recordEntityThreadConversationSwap(db, {
          localId: thread.localId,
          replacedConversationId: session.replacedConversationId,
        });
      }

      const delivered = sendDrivenSessionInput(session.record, parsed.text);
      res.json({
        turn,
        localId: thread.localId,
        seeded: session.seeded,
        delivered,
        // Reported on the POST as well as the GET: this is the request the
        // operator is watching when the swap happens, and a panel that only
        // learned about it on the next poll would render one exchange under
        // the old, false continuity.
        ...(session.replacedConversationId
          ? { conversationSwap: { replacedConversationId: session.replacedConversationId } }
          : {}),
      });
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
          error: getLoggableErrorSummary(err),
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
