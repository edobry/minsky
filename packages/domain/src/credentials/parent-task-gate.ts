/**
 * Block and release a credential request's parent task (mt#4486).
 *
 * The imperative shell around `./parent-task-block`'s pure decisions. Both IO
 * calls are INJECTED rather than reached for, so the command and the resolver
 * each wire their own and both test without a database
 * (`testing-standards.mdc §Testable Design`).
 *
 * ## Both operations fail SOFT, and that is the design
 *
 * Neither the block nor the release may take down the operation it rides on:
 *
 * - The block rides `credentials.request`. The request IS the deliverable — an
 *   agent that cannot get a credential is stuck whether or not a task got
 *   marked. Failing the request because the parent could not be blocked would
 *   turn an optional convenience parameter into a trap, which SC4 forbids.
 * - The release rides the resolver sweep, which runs on a tick over ALL pending
 *   requests. A throw there would abandon the rest of the batch, and the
 *   credential is already stored by that point — the task status is the last and
 *   least consequential step.
 *
 * So both return an outcome describing what happened, and both record a failure
 * rather than swallowing it. The caller reports it; nothing is silent.
 *
 * @see packages/domain/src/credentials/parent-task-block.ts — the pure decisions
 */

import { log } from "@minsky/shared/logger";

import {
  blockReason,
  decideParentBlock,
  decideParentRelease,
  releaseReason,
  type ParentBlockSkipReason,
} from "./parent-task-block";

/** Injected IO. Both members are the narrowest slice of the task service needed. */
export interface ParentTaskGateDeps {
  /** Current status and kind, or null when the task does not exist. */
  readTask(taskId: string): Promise<{ status: string; kind?: string | null } | null>;
  /** Write a status. Throws if the transition is illegal. */
  setStatus(taskId: string, status: string): Promise<void>;
}

/** Identity of the request doing the blocking, for the reason strings. */
export interface RequestIdentity {
  readonly id: string;
  readonly shortId?: string | undefined;
}

export type ParentBlockOutcome =
  | { readonly outcome: "blocked"; readonly entryStatus: string; readonly reason: string }
  | { readonly outcome: "skipped"; readonly why: ParentBlockSkipReason | "task-not-found" }
  | { readonly outcome: "failed"; readonly error: string };

/**
 * Push the parent task to BLOCKED, when the machine allows it.
 *
 * Returns `skipped` — not an error — for a TODO parent or a kind with no BLOCKED
 * state. Those are ordinary and the caller reports them; see the module docblock
 * for why this cannot fail the request.
 */
export async function blockParentTask(
  deps: ParentTaskGateDeps,
  taskId: string,
  request: RequestIdentity
): Promise<ParentBlockOutcome> {
  try {
    const task = await deps.readTask(taskId);
    if (!task) return { outcome: "skipped", why: "task-not-found" };

    const decision = decideParentBlock({ status: task.status, kind: task.kind });
    if (!decision.block) return { outcome: "skipped", why: decision.reason };

    await deps.setStatus(taskId, "BLOCKED");
    return {
      outcome: "blocked",
      entryStatus: decision.entryStatus,
      reason: blockReason(request.shortId, request.id),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("credential request: could not block parent task", {
      taskId,
      askId: request.id,
      error: message,
    });
    return { outcome: "failed", error: message };
  }
}

export type ParentReleaseOutcome =
  | { readonly outcome: "released"; readonly target: string; readonly reason: string }
  | { readonly outcome: "skipped"; readonly why: "no-entry-status" | "not-blocked" }
  | { readonly outcome: "failed"; readonly error: string };

/**
 * Return a released task to a walkable status.
 *
 * `entryStatus` comes off the request payload — its absence means the parent was
 * never blocked, so there is nothing to release.
 *
 * **Re-reads the task and skips unless it is still BLOCKED.** Between the block
 * and the release the principal may have moved it themselves, and writing over
 * that would clobber a human decision with a sweep's stale view. This is the same
 * optimistic posture the resolver already takes on the ask row.
 */
export async function releaseParentTask(
  deps: ParentTaskGateDeps,
  taskId: string,
  entryStatus: string | undefined,
  request: RequestIdentity
): Promise<ParentReleaseOutcome> {
  if (!entryStatus) return { outcome: "skipped", why: "no-entry-status" };

  try {
    const task = await deps.readTask(taskId);
    if (!task || task.status !== "BLOCKED") return { outcome: "skipped", why: "not-blocked" };

    const decision = decideParentRelease(entryStatus);
    await deps.setStatus(taskId, decision.target);

    const reason = releaseReason(request.shortId, request.id, decision);
    if (decision.positionLost) {
      // Worth a log line rather than only a return value: the task silently lost
      // its place in the pipeline, and the machine gave no other signal.
      log.info("credential request: released parent task to READY, prior position unrecoverable", {
        taskId,
        askId: request.id,
        entryStatus,
      });
    }
    return { outcome: "released", target: decision.target, reason };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("credential request: could not release parent task", {
      taskId,
      askId: request.id,
      error: message,
    });
    return { outcome: "failed", error: message };
  }
}
