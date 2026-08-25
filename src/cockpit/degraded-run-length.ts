/**
 * The consecutive-DB-degraded run-length rule, and a replay over it (mt#4598).
 *
 * ## Why this is a module rather than four lines in the health route
 *
 * `consecutiveDegraded` is the input to the tray watchdog's escalation ladder:
 * at `NOT_READY_POLL_THRESHOLD = 24` consecutive degraded polls
 * (`cockpit-tray/src-tauri/src/supervisor.rs:94`) the tray restarts the daemon,
 * and clustered restarts are what reach the restart-storm watchdog — the one
 * layer that alerts the principal (`supervisor.rs:110-111`). So the counter's
 * update rule decides whether a DB problem is ever escalated to a human.
 *
 * The rule was inline in `routes/health.ts`, where the only way to observe it
 * was to drive the whole Express handler. Extracted here so the question this
 * task asks — what value does it actually reach under a PARTIAL degradation? —
 * is answerable by calling a function, per the functional-core discipline.
 *
 * ## What the replay is for
 *
 * The 2026-08-25 window degraded the database for ~95 minutes without ever
 * escalating. The hypothesis was that {@link nextConsecutiveDegraded}'s reset
 * rule makes that structural: a partial degradation is interleaved with
 * successes by definition, and any success zeroes the counter, so it cannot
 * climb to 24. {@link maxConsecutiveDegradedFromGaps} measures that against the
 * real failure sequence instead of assuming it.
 */

/** The `db` field values `/api/health` reports. Anything but `ok` is degraded. */
export type DbStatusReading = "ok" | "degraded" | "unreachable" | (string & {});

/**
 * The counter's update rule, verbatim from `routes/health.ts`: `ok` resets,
 * anything else increments.
 */
export function nextConsecutiveDegraded(current: number, dbStatus: DbStatusReading): number {
  return dbStatus === "ok" ? 0 : current + 1;
}

/** The maximum run length over an explicit sequence of readings. */
export function maxConsecutiveDegraded(readings: readonly DbStatusReading[]): number {
  let current = 0;
  let max = 0;
  for (const reading of readings) {
    current = nextConsecutiveDegraded(current, reading);
    if (current > max) max = current;
  }
  return max;
}

/**
 * Replay a real failure sequence, given only the gaps between logged failures.
 *
 * The daemon logs a line per FAILING probe and nothing per succeeding one, so a
 * production window survives as failure timestamps alone. This reconstructs the
 * run lengths from them:
 *
 * - Polls occur every `pollIntervalSeconds`.
 * - Two failures separated by no more than one poll interval are consecutive
 *   polls, so the run continues.
 * - A larger gap means at least one poll fell between them and did not log a
 *   failure, which resets the run to 1.
 *
 * **The modelling assumption, stated because it is the whole inference:** a poll
 * that logged nothing is treated as having read `ok`. That is the ordinary case
 * and it is not guaranteed — `refreshDbReachability` never issues concurrent
 * probes, so a poll arriving while a slow failing probe is still in flight reads
 * the existing status without logging a second line. Such a poll would read
 * `degraded` and NOT reset. So this returns a **lower bound** on the reachable
 * run length, which is the conservative direction for the question being asked:
 * if even the lower bound were near the threshold the hypothesis would be dead,
 * and the finding is only interesting because the bound comes out far below it.
 */
export function maxConsecutiveDegradedFromGaps(
  gapsSeconds: readonly number[],
  pollIntervalSeconds: number
): { max: number; runs: number; gapsWithinOnePoll: number } {
  if (pollIntervalSeconds <= 0) {
    throw new Error(`pollIntervalSeconds must be positive, got ${pollIntervalSeconds}`);
  }
  // The first logged failure is itself a run of 1.
  let current = gapsSeconds.length >= 0 ? 1 : 0;
  let max = current;
  let runs = 1;
  let gapsWithinOnePoll = 0;
  for (const gap of gapsSeconds) {
    if (gap <= pollIntervalSeconds) {
      gapsWithinOnePoll++;
      current += 1;
      if (current > max) max = current;
    } else {
      current = 1;
      runs++;
    }
  }
  return { max, runs, gapsWithinOnePoll };
}
