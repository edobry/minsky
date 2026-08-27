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
 * ## Verdict shape (adapts ask#6273 / mem#749 to task grain; revised mt#3958)
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
 *     -> `read-failure`. Always FAIL-CLOSED — an unreadable store must not
 *     read as "nobody's here". This is the deliberate inverse of the
 *     session-grain presence signal, which fails OPEN: that signal informs a
 *     "healthy, keep waiting" decision (fail-open is safe), whereas THIS
 *     signal gates the destructive redispatch decision.
 *   - the claim store could not be QUERIED AT ALL (no provider, no connection,
 *     no repo, or a task id that would not normalize) -> `unavailable`,
 *     carrying `unavailableReason` naming which of the four. **mt#3958**: this
 *     used to share a return value with a genuinely empty read
 *     (`no-fresh-claim`), which let a "could not look" condition silently
 *     green-light a destructive redispatch — the mt#3812 double-dispatch this
 *     module's mt#3958 revision exists to close. `unavailable` is NOT itself
 *     fail-open or fail-closed; the CALLER decides, because one of its four
 *     reasons (`no-provider`) is routine — a CLI/test context legitimately
 *     running without persistence — while the other three represent a genuine
 *     failed attempt to look. `dispatch-recover-command.ts`'s contested gate
 *     fails closed on every `unavailableReason` except `no-provider`.
 *   - the read SUCCEEDED and found no fresh peer (or only the caller's own
 *     claim) -> `no-fresh-claim`. This is the ONLY cause that means "looked,
 *     nobody's here" — every other non-`contested` cause means the lookup
 *     itself did not complete.
 *
 * ## `unavailableReason` values
 *
 *   - `no-provider`     — no persistence provider / `getDatabaseConnection`
 *                          accessor at all. Routine: a CLI/test context that
 *                          legitimately runs without persistence.
 *   - `no-connection`   — a provider existed but `getDatabaseConnection()`
 *                          resolved no connection.
 *   - `no-repo`         — a connection existed but `buildPresenceClaimRepository`
 *                          could not build a repo from it.
 *   - `invalid-subject` — `normalizeTaskSubjectId(taskId)` returned "" (a
 *                          non-string / empty / unnormalizable task id).
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
import { getLoggableErrorSummary } from "../errors/index";

/**
 * Structured outcome of the task-grain claim read. `cause` is the load-bearing
 * discriminant — callers branch on it, never on a parsed message string.
 */
export type TaskClaimLivenessCause =
  | "contested"
  | "read-failure"
  | "no-fresh-claim"
  | "unavailable";

/**
 * Why a claim lookup could not even be attempted/completed (`cause === "unavailable"`).
 * `no-provider` is the ONLY reason a caller may legitimately treat as it treats
 * `no-fresh-claim` (abstain, proceed) — see the module docstring's
 * `unavailableReason` values section. The other three represent a failed
 * attempt to look, not a routine absence, and the destructive dispatch-recover
 * path fails closed on them (mt#3958).
 */
export type TaskClaimUnavailableReason =
  | "no-provider"
  | "no-connection"
  | "no-repo"
  | "invalid-subject";

export interface TaskClaimLivenessResult {
  cause: TaskClaimLivenessCause;
  /** The live peer's actorId — present only when `cause === "contested"`. */
  peerActorId?: string;
  /** The live peer's last-refresh time (ISO-8601) — present only when `cause === "contested"`. */
  peerLastRefreshedAt?: string;
  /** Present only when `cause === "unavailable"` — see the module docstring. */
  unavailableReason?: TaskClaimUnavailableReason;
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
 * and classify the result into the verdict shape documented above the module.
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
  // mt#3958: no provider / no connection / no repo / an unnormalizable subject
  // id are all "could not look" — `unavailable`, NOT the same value a
  // genuinely empty read returns (`no-fresh-claim`). This first branch is the
  // one routine case (`no-provider`, a persistence-less CLI/test context) —
  // still not an anomaly, but the caller now gets to see that it's ABSTAINING
  // rather than reporting "looked, nobody's here".
  if (!provider?.getDatabaseConnection) {
    log.debug(
      `[${logContext.source}] resolveTaskClaimLiveness: no persistence provider / ` +
        "getDatabaseConnection — could not check for a peer task-grain claim",
      { taskId }
    );
    return { cause: "unavailable", unavailableReason: "no-provider" };
  }

  let db: unknown;
  try {
    db = await provider.getDatabaseConnection();
  } catch (err) {
    // Acquiring the connection threw — the store is unreadable. Fail closed.
    log.warn(
      `[${logContext.source}] resolveTaskClaimLiveness: getDatabaseConnection() threw ` +
        "(failing closed to contested)",
      { taskId, error: getLoggableErrorSummary(err) }
    );
    return { cause: "read-failure" };
  }
  if (!db) {
    log.debug(
      `[${logContext.source}] resolveTaskClaimLiveness: getDatabaseConnection() resolved no ` +
        "connection — could not check for a peer task-grain claim",
      { taskId }
    );
    return { cause: "unavailable", unavailableReason: "no-connection" };
  }

  try {
    const { buildPresenceClaimRepository } = await import("../presence/index");
    const repo = buildPresenceClaimRepository(db);
    if (!repo) {
      log.debug(
        `[${logContext.source}] resolveTaskClaimLiveness: buildPresenceClaimRepository returned ` +
          "null — could not check for a peer task-grain claim",
        { taskId }
      );
      return { cause: "unavailable", unavailableReason: "no-repo" };
    }
    const { normalizeTaskSubjectId } = await import("../presence/normalize");
    const subjectId = normalizeTaskSubjectId(taskId);
    if (!subjectId) {
      log.debug(
        `[${logContext.source}] resolveTaskClaimLiveness: normalizeTaskSubjectId returned "" — ` +
          "could not check for a peer task-grain claim",
        { taskId }
      );
      return { cause: "unavailable", unavailableReason: "invalid-subject" };
    }

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
      { taskId, error: getLoggableErrorSummary(err) }
    );
    return { cause: "read-failure" };
  }
}
