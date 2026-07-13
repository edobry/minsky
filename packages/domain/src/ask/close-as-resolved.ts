/**
 * Ask lifecycle closure — close an Ask when its triggering event resolves (mt#2593).
 *
 * `authorization.approve` asks (emitted per `session_commit`) and `quality.review`
 * asks (emitted per PR merge / PR creation) accumulate in `suspended` forever after
 * their triggering commit/PR reaches a terminal state, because nothing closes them.
 * This is the shared primitive the emit sites call to close such an Ask once its
 * event has resolved.
 *
 * ## Why the terminal state depends on the Ask's current state
 *
 * `DrizzleAskRepository.create()` inserts every Ask in `detected`; the async
 * advancer (mt#2265) walks `detected -> classified -> routed -> suspended` later.
 * The state machine (state-machine.ts) allows:
 *   - `suspended -> closed` only via `respondAndClose` (atomic suspended->closed
 *     with a response payload)
 *   - `detected|classified|routed -> cancelled` in one hop (`closed` is NOT
 *     reachable from these states)
 *
 * So an Ask closed while still `suspended` lands in `closed` (with an audit-trail
 * response payload); one closed earlier in its lifecycle lands in `cancelled`.
 * `cancelled` is valid from every pre-terminal state, so it is also the robust
 * fallback when the async advancer moves the Ask between our read and our write.
 *
 * All operations are best-effort and idempotent — an already-terminal Ask is a
 * no-op, which is what makes a re-run (or the backfill) safe.
 *
 * Reference: mt#2593 spec (Implementation refinement, 2026-07-13).
 */

import { log } from "@minsky/shared/logger";
import type { Ask } from "./types";
import type { AskRepository } from "./repository";
import { isTerminal } from "./state-machine";
import { findPrRef } from "./reconciler";
import { buildAttentionCost } from "./accounting/index";

/** Input describing who/what resolved the Ask and the audit payload to attach. */
export interface CloseAsResolvedInput {
  /**
   * Responder AgentId — conventionally `system:<event>` for automated closure
   * (e.g. `system:commit-landed`, `system:pr-merged`). Unrecognised-prefix
   * responders map to the `subagent` attention transport (accounting/index.ts).
   */
  responder: string;
  /** Audit payload attached when the Ask lands in `closed` (the suspended path). */
  payload?: Record<string, unknown>;
}

/** Outcome of a single `closeAskAsResolved` call. */
export type CloseAsResolvedOutcome =
  | { kind: "closed"; askId: string }
  | { kind: "cancelled"; askId: string }
  | { kind: "already-terminal"; askId: string }
  | { kind: "not-found"; askId: string }
  | { kind: "skipped"; askId: string; reason: string };

/**
 * Close an Ask whose triggering event has resolved, choosing the terminal state
 * its current lifecycle state can reach.
 *
 * Never throws — every failure is caught and returned as a `skipped` outcome so
 * callers on hot paths (commit, merge) can stay strictly best-effort.
 *
 * @param repo   Ask persistence interface.
 * @param askId  Primary key of the Ask to close.
 * @param input  Responder + audit payload.
 * @returns      The outcome (closed / cancelled / already-terminal / not-found / skipped).
 */
export async function closeAskAsResolved(
  repo: AskRepository,
  askId: string,
  input: CloseAsResolvedInput
): Promise<CloseAsResolvedOutcome> {
  let ask;
  try {
    ask = await repo.getById(askId);
  } catch (err) {
    return { kind: "skipped", askId, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!ask) return { kind: "not-found", askId };
  if (isTerminal(ask.state)) return { kind: "already-terminal", askId };

  const response = {
    responder: input.responder,
    payload: input.payload ?? {},
    attentionCost: buildAttentionCost({ responder: input.responder }),
  };

  try {
    if (ask.state === "suspended") {
      // suspended -> closed, atomically, preserving the audit payload.
      await repo.respondAndClose(askId, { response }, { response });
      return { kind: "closed", askId };
    }
    // detected / classified / routed -> cancelled (the only terminal reachable
    // from these states in one hop; `closed` requires a suspended predecessor).
    await repo.transition(askId, "cancelled");
    return { kind: "cancelled", askId };
  } catch (err) {
    // Race: the async advancer (mt#2265) transitioned the Ask between our read
    // and our write. Re-read once and retry with `cancelled` — valid from every
    // pre-terminal state. If it is already terminal, the close effectively
    // happened (idempotent).
    let fresh;
    try {
      fresh = await repo.getById(askId);
    } catch {
      fresh = null;
    }
    if (!fresh || isTerminal(fresh.state)) return { kind: "already-terminal", askId };
    try {
      await repo.transition(askId, "cancelled");
      return { kind: "cancelled", askId };
    } catch (err2) {
      const reason = err2 instanceof Error ? err2.message : String(err2);
      log.debug("closeAskAsResolved: could not close ask (best-effort)", { askId, reason });
      return { kind: "skipped", askId, reason };
    }
  }
}

/**
 * Select the open `quality.review` Asks that a just-merged PR resolves, from a
 * candidate list (typically `listByParentTask(taskId)`).
 *
 * An Ask is selected when it is a non-terminal `quality.review` AND either:
 *   - it carries a `github-pr` contextRef whose PR number matches `mergedPrNumber`, OR
 *   - it carries no parseable PR ref (same-task fallback — review Asks emitted
 *     without a PR URL are still resolved by the task's merge).
 *
 * A `quality.review` Ask referencing a DIFFERENT PR is not selected (a task can
 * accrue more than one PR over its lifetime).
 */
export function selectOpenReviewAsksForMergedPr(
  asks: Ask[],
  mergedPrNumber: number | undefined
): Ask[] {
  return asks.filter((a) => {
    if (a.kind !== "quality.review" || isTerminal(a.state)) return false;
    const ref = findPrRef(a);
    return ref === null || (mergedPrNumber != null && ref.prNumber === mergedPrNumber);
  });
}
