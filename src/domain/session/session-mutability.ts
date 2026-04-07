/**
 * Session mutability invariants.
 *
 * Per the one-session-one-merge invariant: once a session's PR has been
 * merged, the session is frozen for write operations. Further work on the
 * same task requires a new session on a new branch. This module provides
 * the gate used by every write-path session operation.
 */

import { MinskyError } from "../../errors/index";
import type { SessionRecord } from "./types";

/**
 * Throws if the session's PR has already been merged. Used to gate
 * write-path operations on sessions whose work cycle is complete.
 */
export function assertSessionMutable(session: SessionRecord, operation: string): void {
  if (session.prState?.mergedAt) {
    throw new MinskyError(
      `Cannot ${operation}: session "${session.session}" has a merged PR ` +
        `(merged at ${session.prState.mergedAt}). Per the one-session-one-merge ` +
        `invariant, merged sessions are frozen for write operations.\n\n` +
        `To continue work on this task, delete this session and start a fresh one:\n` +
        `  minsky session delete ${session.session}\n` +
        `  minsky session start --task ${session.taskId ?? "<task-id>"}`
    );
  }
}
