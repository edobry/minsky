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
 */
export interface TaskProviderLike {
  getTask(taskId: string): Promise<{ title: string } | null>;
  getTasks?(ids: string[]): Promise<{ id: string; title: string }[]>;
}

const DEFAULT_TASK_TITLE_TTL_MS = 60_000;

export class TaskTitleCache {
  private cache = new Map<string, string>();
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
        }
      } else {
        const results = await Promise.all(
          ids.map(async (displayId) => {
            const task = await taskProvider.getTask(displayId);
            return { displayId, title: task?.title ?? null };
          })
        );
        for (const { displayId, title } of results) {
          if (title != null) {
            this.cache.set(displayId, title);
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
        }
      } else {
        const results = await Promise.all(
          taskIds.map(async (displayId) => {
            const task = await taskProvider.getTask(displayId);
            return { displayId, title: task?.title ?? null };
          })
        );
        for (const { displayId, title } of results) {
          if (title != null) {
            this.cache.set(displayId, title);
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
}
