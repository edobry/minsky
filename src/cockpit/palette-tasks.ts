/**
 * Recency ordering for the ⌘K palette's task list (mt#2444).
 *
 * GET /api/tasks caps the payload at 500 tasks; with a backlog larger than
 * the cap, an unordered slice is dominated by the oldest backlog and recent
 * tasks never reach the palette (found live 2026-06-11: the slice topped out
 * at mt#2262). Ordering by recency before slicing keeps the cap covering the
 * operationally relevant set.
 */

interface RecencyStamped {
  /** Date at the type level in the domain, but persistence layers can hand
   *  back ISO strings or epoch numbers — the coercion below accepts all three. */
  updatedAt?: Date | string | number;
  createdAt?: Date | string | number;
}

function recencyMs(task: RecencyStamped): number {
  const stamp = task.updatedAt ?? task.createdAt;
  if (stamp === undefined || stamp === null) return 0;
  const ms = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Most recently updated first (createdAt fallback; unstamped or unparseable
 * stamps last). Equal timestamps keep their input order (Array.prototype.sort
 * is stable). Pure — returns a new array.
 */
export function sortTasksByRecency<T extends RecencyStamped>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => recencyMs(b) - recencyMs(a));
}
