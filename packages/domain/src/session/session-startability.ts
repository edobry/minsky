/**
 * Session-start startability — the single source of truth for "can a driven
 * session start for this task, and if not, why" (mt#2959).
 *
 * The status gate in start-session-operations.ts throws using
 * {@link sessionStartBlockedReason}; the cockpit task-detail API
 * (src/cockpit/routes/tasks.ts) reads {@link computeSessionStartability} to
 * render an HONEST "Start session" affordance instead of a dead-end button that
 * surfaces the domain error verbatim (the mt#2959 portal defect).
 *
 * Kind-aware precursor (mt#1870): implementation-kind requires READY (the
 * PLANNING → READY planning gate); umbrella-kind requires PLANNING (there is no
 * READY state — PLANNING → IN-PROGRESS is the direct transition).
 */
import { TASK_STATUS } from "../tasks";

/**
 * Reason a FRESH session-start (no existing workspace to reuse) would be blocked
 * for a task at `status` of `kind`, or `null` when a fresh create would pass the
 * gate.
 *
 * Does NOT account for an existing reusable workspace — that path bypasses this
 * gate entirely (driven-session-launch.ts `resolveTaskWorkspace` reuses a bound
 * workspace regardless of status). Callers that know a workspace exists should
 * treat the task as startable regardless of this result; see
 * {@link computeSessionStartability}.
 */
export function sessionStartBlockedReason(
  status: string | undefined,
  kind: string | undefined
): string | null {
  const normalizedStatus = (status || "").toUpperCase();
  const normalizedKind = kind || "implementation";

  if (normalizedStatus === TASK_STATUS.TODO) {
    // Name the ACTUAL required precursor for the kind — not a first-of-two-gates
    // "set PLANNING" that an implementation task would then bounce off of at the
    // READY gate below (the originating mt#2959 defect).
    return normalizedKind === "umbrella"
      ? "Task must be in PLANNING before a session can start. Move it out of TODO first."
      : "Task must reach READY before a session can start — plan it first (TODO → PLANNING → READY).";
  }

  if (normalizedStatus === TASK_STATUS.PLANNING && normalizedKind !== "umbrella") {
    return "Planning is not yet marked as complete. Set status to READY when investigation is done.";
  }

  return null;
}

/** Startability of a task for the cockpit "Start session" affordance (mt#2959). */
export interface SessionStartability {
  /** True when the cockpit should offer a working "Start session" action. */
  startable: boolean;
  /**
   * Human-readable reason the action is unavailable, shown inline in place of a
   * dead-end button. `null` when startable, or when the task is terminal (the
   * affordance is hidden entirely, matching prior DONE/CLOSED behavior).
   */
  startBlockedReason: string | null;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([TASK_STATUS.DONE, TASK_STATUS.CLOSED]);

/**
 * The whole startability decision for the cockpit surface (mt#2959): combines
 * the fresh-create gate ({@link sessionStartBlockedReason}) with the two facts
 * the gate alone can't see — terminal status and an existing reusable workspace.
 *
 * - terminal (DONE / CLOSED) → not startable, no reason (button hidden, as before).
 * - existing workspace → startable from ANY non-terminal status (reuse path).
 * - otherwise → startable iff a fresh create would pass the gate.
 */
export function computeSessionStartability(
  status: string | undefined,
  kind: string | undefined,
  hasExistingWorkspace: boolean
): SessionStartability {
  const normalizedStatus = (status || "").toUpperCase();

  if (TERMINAL_STATUSES.has(normalizedStatus)) {
    return { startable: false, startBlockedReason: null };
  }
  if (hasExistingWorkspace) {
    return { startable: true, startBlockedReason: null };
  }
  const reason = sessionStartBlockedReason(normalizedStatus, kind);
  return { startable: reason === null, startBlockedReason: reason };
}
