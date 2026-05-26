/**
 * Task List widget (mt#2078)
 *
 * Flat list of all tasks with ID, title, status, kind, tags, and parent.
 * Complements the TaskGraph DAG view — optimised for scanning, searching,
 * and bulk triage rather than dependency visualisation.
 *
 * Same bootstrap pattern as task-graph.ts: factory + lazy singleton deps.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

// ---------------------------------------------------------------------------
// Public shapes — mirrored in TaskList.tsx (no server imports on frontend)
// ---------------------------------------------------------------------------

export interface TaskListItem {
  id: string;
  title: string;
  status: string;
  kind: string;
  tags: string[];
  parentId: string | null;
}

export interface TaskListPayload {
  tasks: TaskListItem[];
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface TaskListDeps {
  taskService: TaskServiceInterface;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskListWidget(getDeps: () => Promise<TaskListDeps>): WidgetModule {
  return {
    id: "task-list",
    title: "Task List",
    updateMode: { type: "polling", intervalMs: 10_000 },

    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const { taskService } = await getDeps();
        const tasks = await taskService.listTasks({});

        const items: TaskListItem[] = tasks.map((t) => ({
          id: formatTaskIdForDisplay(t.id),
          title: t.title,
          status: (t.status ?? "TODO").toUpperCase(),
          kind: t.kind ?? "implementation",
          tags: t.tags ?? [],
          parentId: t.parentTaskId ? formatTaskIdForDisplay(t.parentTaskId) : null,
        }));

        const payload: TaskListPayload = { tasks: items };
        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `task_list error: ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget — lazy singleton
// ---------------------------------------------------------------------------

let _cachedDeps: TaskListDeps | null = null;

async function defaultDepsFactory(): Promise<TaskListDeps> {
  if (_cachedDeps) return _cachedDeps;

  const { getSharedPersistenceService } = await import("../shared-persistence");
  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  const taskService = await createConfiguredTaskService({
    workspacePath: process.cwd(),
    persistenceProvider: provider,
  });

  _cachedDeps = { taskService };
  return _cachedDeps;
}

export const taskListWidget: WidgetModule = createTaskListWidget(defaultDepsFactory);
