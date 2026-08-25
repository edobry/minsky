/**
 * Parent-task blocking decisions for a credential request (mt#4486).
 *
 * mt#4030 shipped `parentTaskId` on the request ask and resolved WHY the task is
 * the right handle: a conversation does not survive, so when the requesting turn
 * ends, the only durable record that work is waiting on a credential is the ask
 * — which no task-graph query reaches. A blocked task is in the queue; an open
 * ask against a task nobody marked blocked is not.
 *
 * This module is the pure half: given a task's current status and kind, decide
 * whether it can be blocked, and given the status it was blocked FROM, decide
 * where it returns. No IO, so both decisions are assertable without a repository.
 *
 * ## The state machine constrains this on both ends, and that shapes the API
 *
 * Read out of `../tasks/workflows.ts` rather than assumed:
 *
 * - **Entry.** `TODO`'s transition list is `["PLANNING", "CLOSED"]` — a TODO task
 *   CANNOT be blocked. A credential request filed for work not yet planned is the
 *   likely case, not an exotic one, so this returns a decision rather than
 *   throwing: the request is the deliverable and must not fail because the parent
 *   happens to sit in the wrong state.
 * - **Entry, by kind.** `state-ops` forbids `→ BLOCKED` entirely (mt#3214). Rather
 *   than hardcoding that kind, this consults the workflow registry, so a kind
 *   added later is handled without an edit here.
 * - **Exit.** `BLOCKED`'s list is `["TODO", "PLANNING", "READY", "CLOSED"]` —
 *   there is no edge back to IN-PROGRESS or IN-REVIEW. A task blocked from either
 *   **cannot be restored to where it was**, so release is a mapping rather than a
 *   restore, and the two lossy cases are named explicitly instead of pretending
 *   otherwise.
 *
 * ## What does NOT release the task
 *
 * Only a SATISFIED request releases. `declined`, `unanswered` and `policy-closed`
 * leave the parent BLOCKED — a blocked task sits in the operator's queue, which
 * is where an unmet credential belongs. `policy-closed` matters most here: per
 * `./request`'s classifier, the router can auto-resolve an
 * `authorization.approve` ask in ~150ms against an unrelated citation with nobody
 * seeing it, so releasing on it would make a task walkable on a credential that
 * was never actually requested of anyone.
 *
 * @see packages/domain/src/tasks/workflows.ts — the transition map this reads
 * @see mt#4030 — shipped the `parentTaskId` plumbing this completes
 */

import { getWorkflow, DEFAULT_KIND } from "../tasks/workflows";

/** The status a task was in when a credential request blocked it. */
export type ParentEntryStatus = string;

/** Why a parent task was left alone rather than blocked. */
export type ParentBlockSkipReason =
  /** The current status has no `→ BLOCKED` edge (TODO is the common case). */
  | "status-not-blockable"
  /** The task's kind forbids BLOCKED entirely (`state-ops`, mt#3214). */
  | "kind-forbids-blocked";

export type ParentBlockDecision =
  | { readonly block: true; readonly entryStatus: ParentEntryStatus }
  | {
      readonly block: false;
      readonly reason: ParentBlockSkipReason;
      readonly status: string;
      readonly kind: string;
    };

const BLOCKED = "BLOCKED";

/**
 * Can this parent task be blocked, and from what status?
 *
 * Derived from the workflow registry rather than a hardcoded status list, so
 * this cannot drift from the machine that will actually validate the write.
 * The two skip reasons are distinguished because they mean different things to a
 * reader: a TODO parent is ordinary, a `state-ops` parent means the caller bound
 * a credential request to a kind that has no blocked state at all.
 */
export function decideParentBlock(input: {
  readonly status: string;
  readonly kind?: string | null;
}): ParentBlockDecision {
  const kind = input.kind || DEFAULT_KIND;
  const workflow = getWorkflow(kind);

  // A kind with no BLOCKED state anywhere in its machine is a different finding
  // from a task that merely sits in a status without the edge — report it as one.
  if (!workflow.states.includes(BLOCKED)) {
    return { block: false, reason: "kind-forbids-blocked", status: input.status, kind };
  }

  const allowed = workflow.transitions[input.status] ?? [];
  if (!allowed.includes(BLOCKED)) {
    return { block: false, reason: "status-not-blockable", status: input.status, kind };
  }

  return { block: true, entryStatus: input.status };
}

/** Where a released task lands, and whether its original position survived. */
export interface ParentReleaseDecision {
  /** The status to transition BLOCKED → to. */
  readonly target: string;
  /**
   * True when `target` is NOT the status the task was blocked from — the machine
   * has no edge back, so position was lost. Surfaced so the caller can say so in
   * the transition reason rather than silently demoting the task.
   */
  readonly positionLost: boolean;
}

/**
 * Where does a released task go?
 *
 * PLANNING and READY round-trip exactly. IN-PROGRESS and IN-REVIEW cannot —
 * `BLOCKED` has no edge back to either — so they land on READY, the nearest legal
 * state that still reads as walkable, with `positionLost` set.
 *
 * READY is chosen over PLANNING for the lossy cases deliberately: the task had
 * already passed its planning gate before it was blocked, and sending it back to
 * PLANNING would ask for that gate to be walked a second time on work that never
 * changed.
 */
export function decideParentRelease(entryStatus: ParentEntryStatus): ParentReleaseDecision {
  if (entryStatus === "PLANNING" || entryStatus === "READY") {
    return { target: entryStatus, positionLost: false };
  }
  return { target: "READY", positionLost: true };
}

/**
 * Human-readable reason for a transition, for the CALLER's result and log line.
 *
 * **Not recorded on the transition itself.** `TaskServiceInterface.setTaskStatus`
 * is `(taskId, status)` — there is no reason parameter, so a status change made
 * here is indistinguishable in the task record from one a human made. That is a
 * real gap and it is stated rather than papered over: the ask is the durable
 * link (it carries `parentTaskId`, and the BLOCKED task renders with it attached
 * via `deriveBlockedSubtype`), so the provenance exists — just not on the
 * transition row.
 *
 * These strings therefore go into the command result and the resolver's log,
 * which is where a reader will actually look for "why did this move".
 */
export function blockReason(askShortId: string | undefined, askId: string): string {
  return `Blocked on credential request ${askShortId ?? askId}`;
}

export function releaseReason(
  askShortId: string | undefined,
  askId: string,
  decision: ParentReleaseDecision
): string {
  const base = `Credential request ${askShortId ?? askId} satisfied`;
  return decision.positionLost
    ? `${base}; returned to READY (BLOCKED has no edge back to the prior status)`
    : base;
}
