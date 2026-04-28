/**
 * Session mutability invariants.
 *
 * Per the one-session-one-merge invariant: once a session's PR has been
 * merged, the session is frozen for write operations. Further work should
 * use subtasks — each phase gets its own task, session, and PR.
 */

import { MinskyError } from "../../errors/index";
import type { SessionRecord } from "./types";

/**
 * Throws if the session's PR has already been merged. Used to gate
 * write-path operations on sessions whose work cycle is complete.
 */
export function assertSessionMutable(session: SessionRecord, operation: string): void {
  if (session.prState?.mergedAt) {
    const taskId = session.taskId ?? "<task-id>";
    throw new MinskyError(
      `Cannot ${operation}: session "${session.sessionId}" has a merged PR ` +
        `(merged at ${session.prState.mergedAt}). Per the one-session-one-merge ` +
        `invariant, merged sessions are frozen for write operations.\n\n` +
        `To continue work, create a subtask for the next phase:\n` +
        `  minsky tasks create --parent ${taskId} --title "Next phase"\n` +
        `  minsky session start --task <new-subtask-id>\n\n` +
        `This gives each phase its own task ID, session, and PR.`
    );
  }
}
