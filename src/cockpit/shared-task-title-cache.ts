/**
 * Process-wide lazy {@link TaskTitleCache} for cockpit ROUTE handlers (mt#3691).
 *
 * Lifted verbatim from `routes/conversations.ts`, where it was module-private
 * and served the conversation-overview label alone. `routes/agents.ts` now
 * labels its conversation candidates through the same precedence, and a second
 * private copy would be a second cache over the same task backend, warming and
 * expiring independently.
 *
 * Lazily constructed so a cockpit boot with no SQL-capable persistence provider
 * never pays for it, and module-level so repeated polls reuse one cache rather
 * than re-hitting the task backend per request — the same posture
 * `widgets/context-inspector.ts` takes for the picker's labels (its cache stays
 * widget-instance-scoped: it is constructed per widget factory call and tuned
 * for that widget's 50-id poll, so it is deliberately not folded in here).
 *
 * A null task service degrades tier-1/tier-3 task-title resolution to "not
 * found" rather than throwing; `fetchEnrichment` already treats that as a tier
 * miss.
 */
import type { TaskTitleCache } from "./task-title-cache";

let sharedTitleCache: TaskTitleCache | null = null;

/**
 * The shared cache, or null when one cannot be constructed (no persistence
 * provider). Callers treat null as "no task titles available" — every label
 * tier that needs one is simply skipped.
 */
export async function getSharedTaskTitleCache(): Promise<TaskTitleCache | null> {
  if (sharedTitleCache) return sharedTitleCache;
  try {
    const { TaskTitleCache: Cache } = await import("./task-title-cache");
    const { getServerTaskService } = await import("./db-providers");
    sharedTitleCache = new Cache(async () => {
      const taskService = await getServerTaskService();
      return (
        taskService ?? {
          async getTask() {
            return null;
          },
          async getTasks() {
            return [];
          },
        }
      );
    });
    return sharedTitleCache;
  } catch {
    return null;
  }
}
