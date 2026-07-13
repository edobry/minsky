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
/**
 * Build the response payload attached when an Ask is closed (suspended and
 * responded paths). Computes `attentionCost`, so callers MUST invoke it inside a
 * try — this is why `closeByCurrentState` is only ever called from within
 * `closeAskAsResolved`'s guarded blocks (the never-throws contract).
 */
function buildCloseResponse(input: CloseAsResolvedInput) {
  return {
    responder: input.responder,
    payload: input.payload ?? {},
    attentionCost: buildAttentionCost({ responder: input.responder }),
  };
}

/**
 * Close `ask` using the terminal state reachable from its CURRENT lifecycle
 * state (state-machine.ts):
 *   - already terminal            -> no-op
 *   - `suspended`                 -> `closed` (respondAndClose, atomic, audit payload)
 *   - `responded`                 -> `closed` (repo.close; `cancelled` is INVALID
 *                                    from `responded`, and the Ask already carries
 *                                    a response — e.g. a reconciler-posted review —
 *                                    which is preserved)
 *   - `detected`/`classified`/`routed` -> `cancelled` (the only terminal reachable
 *                                    in one hop; `closed` needs a suspended/responded
 *                                    predecessor)
 *
 * May throw on an invalid transition or a `buildAttentionCost` failure — the
 * caller catches and either retries against a re-read state or returns `skipped`.
 */
async function closeByCurrentState(
  repo: AskRepository,
  ask: Ask,
  input: CloseAsResolvedInput
): Promise<CloseAsResolvedOutcome> {
  if (isTerminal(ask.state)) return { kind: "already-terminal", askId: ask.id };
  if (ask.state === "suspended") {
    const response = buildCloseResponse(input);
    await repo.respondAndClose(ask.id, { response }, { response });
    return { kind: "closed", askId: ask.id };
  }
  if (ask.state === "responded") {
    const response = ask.response ?? buildCloseResponse(input);
    await repo.close(ask.id, { response });
    return { kind: "closed", askId: ask.id };
  }
  await repo.transition(ask.id, "cancelled");
  return { kind: "cancelled", askId: ask.id };
}

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

  try {
    return await closeByCurrentState(repo, ask, input);
  } catch {
    // Race: the async advancer (mt#2265) transitioned the Ask between our read
    // and our write. Re-read once and retry against its now-current state (which
    // may need a different terminal than the one we first attempted).
    let fresh;
    try {
      fresh = await repo.getById(askId);
    } catch {
      fresh = null;
    }
    if (!fresh) return { kind: "already-terminal", askId };
    try {
      return await closeByCurrentState(repo, fresh, input);
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
  // Conservative under incomplete PR metadata (reviewer R3, PR #1890): with no
  // merged PR number we cannot attribute a no-ref review Ask to *this* merge, so
  // select nothing rather than risk over-closing unrelated same-task review Asks.
  if (mergedPrNumber == null) return [];
  return asks.filter((a) => {
    if (a.kind !== "quality.review" || isTerminal(a.state)) return false;
    const ref = findPrRef(a);
    // No PR ref -> same-task fallback; with a ref -> require it matches.
    return ref === null || ref.prNumber === mergedPrNumber;
  });
}
