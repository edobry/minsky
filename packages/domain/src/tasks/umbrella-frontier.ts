/**
 * The umbrella frontier: which children of a parent task are dispatchable
 * right now, and which are blocked by an unmet dependency.
 *
 * **Extracted from `src/adapters/shared/commands/tasks/orchestrate-command.ts`
 * (mt#4571), not restated.** Two consumers need this answer and they must not be
 * able to disagree about it:
 *
 *  - `tasks.orchestrate` — an agent asking "what can I dispatch under this
 *    umbrella?", which keeps its historical `["TODO"]` default.
 *  - The unattended supervisor (`../supervision/`), which asks the same question
 *    every tick with an EXPLICIT status filter.
 *
 * mt#4571 SC5 offered two ways to keep the supervisor off `tasks.orchestrate`'s
 * `["TODO"]` default — pass `status` explicitly, or consume `TaskRoutingService`
 * directly. This module is the reason behind both rather than either: a second
 * implementation of "is this child blocked?" is exactly the drift the whole task
 * exists to prevent, since a supervisor that computes the frontier differently
 * from the command an operator inspects it with would dispatch blocked work and
 * report that it had not.
 *
 * **Why not `TaskRoutingService.findAvailableTasks`.** That answers a different
 * question — "across the whole backlog, what is available?" — and has no notion
 * of an umbrella. Scoping it to a parent's children after the fact would mean
 * listing every task in the backend on every 60s tick.
 *
 * **Bulk reads, not N+1 (`efficient-database-queries.mdc`).** The command this
 * was extracted from issued one `getTask` per child plus one per dependency of
 * each child. That is tolerable for a hand-typed command and not for a sweeper
 * running every 60 seconds, so the extraction bulk-reads: one relationship query
 * for the children's `depends` edges, and one `getTasks` for every child and
 * dependency id at once.
 *
 * @see mt#4571 — the unattended supervisor this was extracted for
 * @see mt#2264 — the guard that catches a spec asserting an edge the graph lacks,
 *   which is the failure this frontier silently converts into "ready: true"
 */
import { isTerminal } from "./workflows";

/** One child of the umbrella, with the reason it is or is not dispatchable. */
export interface FrontierChild {
  taskId: string;
  title: string;
  status: string;
  /**
   * Dependency task ids that are still non-terminal, i.e. still blocking. An
   * id whose task could not be resolved is included here — an unresolvable
   * dependency is treated as blocking, never as satisfied.
   */
  blockedBy: string[];
  /** True exactly when `blockedBy` is empty. */
  ready: boolean;
}

export interface UmbrellaFrontier {
  parentTaskId: string;
  /** Children in the status filter with no unmet dependency. */
  dispatchable: FrontierChild[];
  /** Children in the status filter with at least one unmet dependency. */
  blocked: FrontierChild[];
  /** `dispatchable.length + blocked.length` — children that passed the status filter. */
  total: number;
  /** Children of the umbrella that did NOT pass the status filter. */
  filteredOut: number;
}

/**
 * The graph and task reads this computation needs, as an interface rather than
 * the concrete services, so the supervisor's tick can be tested against a fake
 * graph with no database (`/implement-task` §6 testable-design checkpoint).
 */
export interface UmbrellaFrontierDeps {
  /** Child task ids of `parentTaskId` (the `parent` edge, stored child -> parent). */
  listChildren(parentTaskId: string): Promise<string[]>;
  /**
   * `depends` edges for the given task ids. `fromTaskId` depends on `toTaskId`
   * — the same direction `TaskGraphService.getRelationshipsForTasks` returns.
   */
  getDependsRelationships(
    taskIds: string[]
  ): Promise<Array<{ fromTaskId: string; toTaskId: string }>>;
  /** Bulk task read. Ids with no task are simply absent from the result. */
  getTasks(taskIds: string[]): Promise<Array<{ id: string; title?: string; status?: string }>>;
}

/** Status recorded for a child whose task row could not be resolved. */
export const UNKNOWN_STATUS = "UNKNOWN";

/**
 * Compute the dispatchable/blocked split for an umbrella's children.
 *
 * `statusFilter` is REQUIRED and has no default on purpose. The default it
 * would otherwise carry — `["TODO"]`, inherited from `tasks.orchestrate` — is
 * precisely the trap mt#4571 SC5 names: a supervisor at that default silently
 * skips every PLANNING, READY, IN-PROGRESS and IN-REVIEW child, i.e. exactly
 * the ones already planned. Callers state what they mean; the command supplies
 * its own historical default at its own boundary.
 */
export async function computeUmbrellaFrontier(
  parentTaskId: string,
  statusFilter: readonly string[],
  deps: UmbrellaFrontierDeps
): Promise<UmbrellaFrontier> {
  const childIds = await deps.listChildren(parentTaskId);
  if (childIds.length === 0) {
    return { parentTaskId, dispatchable: [], blocked: [], total: 0, filteredOut: 0 };
  }

  const childTasks = await deps.getTasks(childIds);
  const childById = new Map(childTasks.map((t) => [t.id, t]));

  // Apply the status filter before any dependency work — a child outside the
  // filter costs nothing further.
  const inFilter: Array<{ taskId: string; title: string; status: string }> = [];
  let filteredOut = 0;
  for (const childId of childIds) {
    const task = childById.get(childId);
    const status = task?.status ?? UNKNOWN_STATUS;
    if (!statusFilter.includes(status)) {
      filteredOut += 1;
      continue;
    }
    inFilter.push({ taskId: childId, title: task?.title ?? "(unknown)", status });
  }

  if (inFilter.length === 0) {
    return { parentTaskId, dispatchable: [], blocked: [], total: 0, filteredOut };
  }

  // One relationship query for every surviving child's dependencies...
  const relationships = await deps.getDependsRelationships(inFilter.map((c) => c.taskId));
  const dependenciesByChild = new Map<string, string[]>();
  for (const child of inFilter) dependenciesByChild.set(child.taskId, []);
  for (const rel of relationships) {
    dependenciesByChild.get(rel.fromTaskId)?.push(rel.toTaskId);
  }

  // ...and one bulk task read for every distinct dependency id, so deciding
  // "is this dependency still blocking?" costs one query rather than one per
  // edge. A dependency that is ALSO a child of this umbrella is already in
  // `childById`; ask for the rest.
  const dependencyIds = new Set<string>();
  for (const ids of dependenciesByChild.values()) {
    for (const id of ids) if (!childById.has(id)) dependencyIds.add(id);
  }
  const dependencyTasks = dependencyIds.size > 0 ? await deps.getTasks([...dependencyIds]) : [];
  const statusById = new Map<string, string>();
  for (const t of childTasks) if (t.status) statusById.set(t.id, t.status);
  for (const t of dependencyTasks) if (t.status) statusById.set(t.id, t.status);

  const dispatchable: FrontierChild[] = [];
  const blocked: FrontierChild[] = [];

  for (const child of inFilter) {
    const blockedBy: string[] = [];
    for (const depId of dependenciesByChild.get(child.taskId) ?? []) {
      const depStatus = statusById.get(depId);
      // An unresolvable dependency blocks. The alternative — treating "I could
      // not read it" as "it is done" — is the exact false-positive shape this
      // supervisor makes expensive: it would dispatch blocked work unattended.
      if (depStatus === undefined || !isTerminal(depStatus)) {
        blockedBy.push(depId);
      }
    }
    const entry: FrontierChild = {
      taskId: child.taskId,
      title: child.title,
      status: child.status,
      blockedBy,
      ready: blockedBy.length === 0,
    };
    (entry.ready ? dispatchable : blocked).push(entry);
  }

  return {
    parentTaskId,
    dispatchable,
    blocked,
    total: dispatchable.length + blocked.length,
    filteredOut,
  };
}
