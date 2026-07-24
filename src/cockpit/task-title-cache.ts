/**
 * Shared task-title lookup cache (extracted from widgets/agents.ts, mt#2770).
 *
 * Both the Agents widget (mt#1145) and the Context-inspector widget (mt#2023,
 * conversation labeling per mt#2770) need to batch-resolve task titles for a
 * set of task IDs without re-querying the task backend on every poll tick.
 * This module is the single home for that TTL-cached batch lookup so the two
 * widgets don't drift.
 *
 * Behavior is unchanged from the original agents.ts implementation — this is
 * a pure extraction, not a redesign.
 */

/**
 * Minimal interface for task title look-up. Keeps coupling thin and test
 * doubles trivial.
 *
 * - `getTask(id)` — single look-up; `id` is in display form (e.g. `"mt#123"`).
 * - `getTasks(ids)` — optional batch look-up. IDs are in display form. Returns
 *   only found tasks (missing IDs are omitted, not returned as null). Returned
 *   `id` values must match the input display-form IDs.
 *
 * `status` is OPTIONAL on both (mt#3174): existing providers (the two
 * pre-existing consumers of this interface, `widgets/agents.ts` and
 * `widgets/context-inspector.ts`) return `{id, title}` with no status field
 * and remain valid implementations unchanged. Providers backing the new
 * `getTaskMeta` batch method (below) supply `status` so the hover primitive
 * can show it.
 */
export interface TaskProviderLike {
  getTask(taskId: string): Promise<{ title: string; status?: string } | null>;
  getTasks?(ids: string[]): Promise<{ id: string; title: string; status?: string }[]>;
}

/** `{title, status}` pair returned by {@link TaskTitleCache.getTaskMeta}. */
export interface TaskMeta {
  title: string;
  status: string;
}

const DEFAULT_TASK_TITLE_TTL_MS = 60_000;

export class TaskTitleCache {
  private cache = new Map<string, string>();
  /**
   * Status sibling to `cache` above (mt#3174) — populated alongside title
   * whenever the underlying provider supplies a `status` field. Kept as a
   * SEPARATE map (not folded into `cache`) so `getTitles`'s existing
   * `Map<string, string>` return shape and behavior are completely
   * unchanged — this is purely additive internal bookkeeping.
   */
  private statusCache = new Map<string, string>();
  private attempted = new Set<string>();
  private lastPopulatedAt = 0;
  private populatePromise: Promise<void> | null = null;

  constructor(
    private readonly getTaskProvider: () => Promise<TaskProviderLike>,
    private readonly ttlMs: number = DEFAULT_TASK_TITLE_TTL_MS
  ) {}

  private isStale(): boolean {
    return Date.now() - this.lastPopulatedAt > this.ttlMs;
  }

  async getTitles(taskIds: string[]): Promise<Map<string, string>> {
    if (!this.isStale() && this.cache.size > 0) {
      const result = new Map<string, string>();
      const missing: string[] = [];
      for (const id of taskIds) {
        const title = this.cache.get(id);
        if (title != null) {
          result.set(id, title);
        } else if (!this.attempted.has(id)) {
          missing.push(id);
        }
      }

      if (missing.length > 0) {
        await this.fetchAndCache(missing);
        for (const id of missing) {
          const title = this.cache.get(id);
          if (title != null) result.set(id, title);
        }
      }

      return result;
    }

    if (this.populatePromise) {
      await this.populatePromise;
      const result = new Map<string, string>();
      for (const id of taskIds) {
        const title = this.cache.get(id);
        if (title != null) result.set(id, title);
      }
      return result;
    }

    this.populatePromise = this.populate(taskIds);
    try {
      await this.populatePromise;
    } finally {
      this.populatePromise = null;
    }

    const result = new Map<string, string>();
    for (const id of taskIds) {
      const title = this.cache.get(id);
      if (title != null) result.set(id, title);
    }
    return result;
  }

  private async fetchAndCache(ids: string[]): Promise<void> {
    try {
      const taskProvider = await this.getTaskProvider();
      if (typeof taskProvider.getTasks === "function") {
        const tasks = await taskProvider.getTasks(ids);
        for (const task of tasks) {
          this.cache.set(task.id, task.title);
          if (task.status != null) this.statusCache.set(task.id, task.status);
        }
      } else {
        const results = await Promise.all(
          ids.map(async (displayId) => {
            const task = await taskProvider.getTask(displayId);
            return { displayId, title: task?.title ?? null, status: task?.status ?? null };
          })
        );
        for (const { displayId, title, status } of results) {
          if (title != null) {
            this.cache.set(displayId, title);
            if (status != null) this.statusCache.set(displayId, status);
          }
        }
      }
      for (const id of ids) {
        this.attempted.add(id);
      }
    } catch {
      // Non-fatal — missing IDs stay uncached
    }
  }

  private async populate(taskIds: string[]): Promise<void> {
    try {
      const taskProvider = await Promise.race([
        this.getTaskProvider(),
        new Promise<TaskProviderLike>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Task provider init timeout (5s)")), 5000)
        ),
      ]);

      if (typeof taskProvider.getTasks === "function") {
        const tasks = await taskProvider.getTasks(taskIds);
        for (const task of tasks) {
          this.cache.set(task.id, task.title);
          if (task.status != null) this.statusCache.set(task.id, task.status);
        }
      } else {
        const results = await Promise.all(
          taskIds.map(async (displayId) => {
            const task = await taskProvider.getTask(displayId);
            return { displayId, title: task?.title ?? null, status: task?.status ?? null };
          })
        );
        for (const { displayId, title, status } of results) {
          if (title != null) {
            this.cache.set(displayId, title);
            if (status != null) this.statusCache.set(displayId, status);
          }
        }
      }
      this.lastPopulatedAt = Date.now();
      for (const id of taskIds) {
        this.attempted.add(id);
      }
    } catch {
      // Task provider failure is non-fatal — rows degrade to taskTitle: null.
    }
  }

  /**
   * Batch-resolve `{title, status}` for a set of task IDs (mt#3174).
   *
   * Added ALONGSIDE `getTitles` (not a signature change to it) so the two
   * existing consumers (`widgets/agents.ts`, `widgets/context-inspector.ts`)
   * are completely untouched — they keep calling `getTitles` and keep
   * getting `Map<string, string>` back. This method reuses the SAME
   * TTL/attempted bookkeeping as `getTitles` (so a mixed caller population
   * doesn't double-fetch), but reads/writes `statusCache` in addition to
   * `cache`. IDs the provider has no status for (only `title`) are simply
   * absent from the returned map's per-entry `status` — never surfaced as
   * an error.
   */
  async getTaskMeta(taskIds: string[]): Promise<Map<string, TaskMeta>> {
    const titles = await this.getTitles(taskIds);
    const result = new Map<string, TaskMeta>();
    for (const [id, title] of titles) {
      const status = this.statusCache.get(id);
      if (status != null) result.set(id, { title, status });
    }
    return result;
  }
}
