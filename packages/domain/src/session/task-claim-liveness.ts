/**
 * Task-grain claim liveness read for `tasks.dispatch-recover` (mt#3121).
 *
 * `tasks.dispatch-recover`'s staleness check consults SESSION-grain presence
 * (`resolveLastPresenceActivityAtMs`, `subject_kind = "session"`) — it answers
 * "is the dispatched subagent still working IN THIS SESSION?" It has never
 * consulted TASK-grain claims (`subject_kind = "task"`), so it cannot see a
 * PEER CONVERSATION that owns the dispatch chain and is actively working the
 * task from a different session. That blind spot let the recover tool
 * green-light redispatching into a live actor's workspace (the mt#3718
 * collision; the originating mt#3112/3113 incident). This module is the
 * task-grain read that closes it.
 *
 * ## Four-branch verdict (adapts ask#6273 / mem#749 to task grain)
 *
 * mem#749 records the operator's ask#6273 ruling for the SESSION-grain
 * delete/cleanup/recover liveness gates. This module transports its shape to
 * task grain and returns a structured `cause` (NEVER a parsed reason string,
 * per that ruling's implementation contract):
 *
 *   - a FRESH claim from an actor OTHER THAN the caller exists  -> `contested`
 *     (a live peer owns the task; surface its actorId + last-refresh and route
 *     the caller to the operator, not to a redispatch).
 *   - the claim store READ FAILS (a provider/db/repo existed and then threw)
 *     -> `read-failure`, which the caller treats as FAIL-CLOSED (do not
 *     green-light recovery on an unreadable store). This is the deliberate
 *     inverse of the session-grain presence signal, which fails OPEN: that
 *     signal informs a "healthy, keep waiting" decision (fail-open is safe),
 *     whereas THIS signal gates the destructive redispatch decision (an
 *     unreadable store must not read as "nobody's here").
 *   - NO claim exists, or only the CALLER's own claim(s) exist -> `no-fresh-claim`
 *     (abstain — the session-grain classification decides recover/escalate as
 *     before). A persistence-less context (CLI / test) is this branch too, not
 *     `read-failure`: absence of a provider is routine, not an anomaly.
 *
 * ## Self-exclusion (mt#3121 SC4)
 *
 * A probe call carrying `taskId` writes a task-grain claim for the CALLER
 * itself (`server.ts` `writeTaskClaim`), so a naive "any fresh claim" check
 * would flag every caller as its own peer. `callerActorId` is excluded by
 * exact string equality — the claim's `actorId` and the server-resolved
 * caller agentId are the same `resolveCallerAgentId` value (ADR-006), so no
 * normalization is needed. A `null` callerActorId (CLI, or an MCP path that
 * could not resolve identity) excludes nothing, which is correct: a CLI caller
 * writes no presence claims, so there is no self to drop.
 *
 * @see mt#3121 — this task
 * @see mem#749 / ask#6273 — the session-grain four-branch ruling this adapts
 * @see packages/domain/src/session/presence-activity.ts — the session-grain sibling (fails OPEN)
 * @see docs/architecture/presence-claims.md — the presence-claim subsystem
 */
import { log } from "@minsky/shared/logger";
import { PRESENCE_CLAIM_TTL_MS } from "../presence/types";
import type { AnnotatedPresenceClaim } from "../presence/types";

/**
 * Structured outcome of the task-grain claim read. `cause` is the load-bearing
 * discriminant — callers branch on it, never on a parsed message string.
 */
export type TaskClaimLivenessCause = "contested" | "read-failure" | "no-fresh-claim";

export interface TaskClaimLivenessResult {
  cause: TaskClaimLivenessCause;
  /** The live peer's actorId — present only when `cause === "contested"`. */
  peerActorId?: string;
  /** The live peer's last-refresh time (ISO-8601) — present only when `cause === "contested"`. */
  peerLastRefreshedAt?: string;
}

/**
 * The minimal provider shape this lookup needs — a `getDatabaseConnection`
 * accessor. Deliberately narrower than the full persistence-provider interface
 * so callers can pass whatever provider-shaped value they already have.
 */
export interface TaskClaimProvider {
  getDatabaseConnection?: () => Promise<unknown>;
}

/** Identifies the calling site in log lines so a shared-helper failure is traceable to its origin. */
export interface TaskClaimLogContext {
  source: string;
}

/**
 * Pure classifier (functional core): given the task's annotated claims and the
 * caller's actorId, return `contested` (with the freshest live peer) or
 * `no-fresh-claim`. The I/O shell (`resolveTaskClaimLiveness`) handles the
 * `read-failure` branch; this function never sees it.
 *
 * `claims` is expected ordered desc by `lastRefreshedAt` (as `listClaims`
 * returns them), so the first non-stale non-caller claim is the freshest peer.
 * No I/O, no clock — unit-testable in isolation.
 */
export function classifyFreshPeerClaim(
  claims: AnnotatedPresenceClaim[],
  callerActorId: string | null
): TaskClaimLivenessResult {
  const peer = claims.find((c) => !c.stale && c.actorId !== callerActorId);
  if (peer) {
    return {
      cause: "contested",
      peerActorId: peer.actorId,
      peerLastRefreshedAt: peer.lastRefreshedAt,
    };
  }
  return { cause: "no-fresh-claim" };
}

/**
 * Read the task-grain presence claims for `taskId`, exclude the caller's own,
 * and classify the result into the four-branch verdict above.
 *
 * `staleThresholdMs` bounds "fresh": a claim whose `lastRefreshedAt` is within
 * this window counts as a live peer. Defaults to `PRESENCE_CLAIM_TTL_MS` (15m),
 * the same window `tasks.claims.list` and the presence system use for their
 * fresh/stale split.
 */
export async function resolveTaskClaimLiveness(
  taskId: string,
  callerActorId: string | null,
  provider: TaskClaimProvider | null | undefined,
  logContext: TaskClaimLogContext,
  staleThresholdMs: number = PRESENCE_CLAIM_TTL_MS
): Promise<TaskClaimLivenessResult> {
  // No provider / no connection / no repo is the ABSTAIN branch (no-fresh-claim),
  // not read-failure: a persistence-less context is routine, not an anomaly.
  if (!provider?.getDatabaseConnection) {
    log.debug(
      `[${logContext.source}] resolveTaskClaimLiveness: no persistence provider / ` +
        "getDatabaseConnection — abstaining (no task-claim signal)",
      { taskId }
    );
    return { cause: "no-fresh-claim" };
  }

  let db: unknown;
  try {
    db = await provider.getDatabaseConnection();
  } catch (err) {
    // Acquiring the connection threw — the store is unreadable. Fail closed.
    log.warn(
      `[${logContext.source}] resolveTaskClaimLiveness: getDatabaseConnection() threw ` +
        "(failing closed to contested)",
      { taskId, error: err instanceof Error ? err.message : String(err) }
    );
    return { cause: "read-failure" };
  }
  if (!db) {
    log.debug(
      `[${logContext.source}] resolveTaskClaimLiveness: getDatabaseConnection() resolved no ` +
        "connection — abstaining (no task-claim signal)",
      { taskId }
    );
    return { cause: "no-fresh-claim" };
  }

  try {
    const { buildPresenceClaimRepository } = await import("../presence/index");
    const repo = buildPresenceClaimRepository(db);
    if (!repo) {
      log.debug(
        `[${logContext.source}] resolveTaskClaimLiveness: buildPresenceClaimRepository returned ` +
          "null — abstaining (no task-claim signal)",
        { taskId }
      );
      return { cause: "no-fresh-claim" };
    }
    const { normalizeTaskSubjectId } = await import("../presence/normalize");
    const subjectId = normalizeTaskSubjectId(taskId);
    if (!subjectId) return { cause: "no-fresh-claim" };

    // Ordered desc by lastRefreshedAt, each annotated with `stale` against the
    // threshold. The freshest non-caller, non-stale claim is the live peer.
    const claims = await repo.listClaims("task", subjectId, staleThresholdMs);
    return classifyFreshPeerClaim(claims, callerActorId);
  } catch (err) {
    // A provider/db existed and the read then threw — an operational anomaly
    // (query failure, unexpected dynamic-import shape). Fail closed.
    log.warn(
      `[${logContext.source}] resolveTaskClaimLiveness read failed unexpectedly ` +
        "(failing closed to contested)",
      { taskId, error: err instanceof Error ? err.message : String(err) }
    );
    return { cause: "read-failure" };
  }
}
