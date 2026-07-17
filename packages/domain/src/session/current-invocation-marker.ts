/**
 * Current-invocation marker (mt#2831 R1 BLOCKING #1) — the "thread the invocation
 * id" mechanism that lets the SubagentStop hook bind a Stop-time update to the
 * EXACT `subagent_invocations` row it belongs to, instead of guessing by
 * `subagentSessionId` (ambiguous once a dispatch has been auto-resumed and a
 * session hosts more than one attempt's row).
 *
 * Convention: a plain-text file at
 * `<sessionDir>/.minsky/sessions/<sessionId>/current-invocation-id`, sibling to
 * the `handoff.md` convention the dispatch-recovery probe already reads
 * (`packages/domain/src/session/dispatch-recovery-probe.ts`). Written at
 * dispatch time (the ORIGINAL attempt) and overwritten at recovery time (each
 * RESUMED attempt) — the file always names whichever invocation is currently
 * "the one running in this workspace." The SubagentStop hook reads it once at
 * Stop time and passes the id through as `SubagentInvocationInput.id`, which
 * `SubagentDispatchTracker.recordSubagentInvocation`'s strong-binding path
 * consumes directly (see that method's docstring).
 *
 * Fail-safe by design: a missing or unreadable marker is not an error — it just
 * means the caller falls back to the tracker's heuristic (subagentSessionId +
 * open-row-first) upsert path, same as before this mechanism existed.
 *
 * @see mt#2831 — this task
 * @see src/mcp/subagent-dispatch-tracker.ts — the strong-binding consumer
 * @see .minsky/hooks/record-subagent-invocation.ts — the SubagentStop reader
 * @see src/adapters/shared/commands/tasks/dispatch-command.ts — dispatch-time writer
 * @see src/adapters/shared/commands/tasks/dispatch-recover-command.ts — recovery-time writer
 */

/**
 * Resolve the marker file's path for a given session workspace + session id.
 * Exported for testing and for callers that need the path without performing I/O.
 */
export function getCurrentInvocationMarkerPath(sessionDir: string, sessionId: string): string {
  return `${sessionDir}/.minsky/sessions/${sessionId}/current-invocation-id`;
}

/**
 * Write (or overwrite) the current-invocation marker. Fail-safe: swallows any
 * write error and returns `false` rather than throwing — writing this marker is
 * a best-effort deterministic-attribution aid, not a correctness-critical write
 * (the tracker's heuristic fallback still functions if this never lands).
 */
export async function writeCurrentInvocationMarker(
  sessionDir: string,
  sessionId: string,
  invocationId: string
): Promise<boolean> {
  try {
    const path = getCurrentInvocationMarkerPath(sessionDir, sessionId);
    await Bun.write(path, invocationId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current-invocation marker. Returns `null` when the file is absent,
 * unreadable, or empty — callers treat that as "no strong binding available,"
 * not an error.
 */
export async function readCurrentInvocationMarker(
  sessionDir: string,
  sessionId: string
): Promise<string | null> {
  try {
    const path = getCurrentInvocationMarkerPath(sessionDir, sessionId);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const content = (await file.text()).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}
