/**
 * Task Mutation Commands
 *
 * Interface-agnostic write operations: setStatus, update, create,
 * createFromTitleAndSpec, delete.
 */

import { z } from "zod";
import {
  createConfiguredTaskService as createConfiguredTaskServiceImpl,
  TaskServiceOptions,
  TaskServiceInterface,
} from "../taskService";
import type { Task } from "../types";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import {
  taskStatusSetParamsSchema,
  taskCreateParamsSchema,
  taskCreateFromTitleAndSpecParamsSchema,
  taskDeleteParamsSchema,
  type TaskStatusSetParams,
  type TaskCreateParams,
  type TaskCreateFromTitleAndSpecParams,
  type TaskDeleteParams,
} from "../../schemas/tasks";
import { resolveRepoPath, normalizeTaskIdInput } from "./shared-helpers";
import { isKnownKind, isTerminalTaskStatus, WORKFLOWS } from "../workflows";
import {
  validateStatusTransition,
  hasCloseoutEvidence,
  READY_TO_DONE_MISSING_EVIDENCE_MESSAGE,
} from "../status-transitions";
import { TaskStatus } from "../taskConstants";
import type { TaskGraphService } from "../task-graph-service";
import type { BasePersistenceProvider } from "../../persistence/types";

function requirePersistence(
  provider: BasePersistenceProvider | undefined
): BasePersistenceProvider {
  if (!provider) {
    throw new Error(
      "persistenceProvider is required when taskService is not injected. " +
        "Provide one of: deps.taskService or deps.persistenceProvider."
    );
  }
  return provider;
}

/**
 * Factory signature for the test-injection seam. Persistence is NOT required
 * here because test mocks don't use it — they return pre-built mock services.
 * The real `createConfiguredTaskServiceImpl` requires persistence and is called
 * directly on the production path with `requirePersistence(deps?.persistenceProvider)`.
 */
type InjectedTaskServiceFactory = (
  options: Omit<TaskServiceOptions, "persistenceProvider">
) => Promise<TaskServiceInterface>;

/**
 * Read a task's children via the injected `taskGraphService` and return the
 * subset that are NOT terminal (per `isTerminalTaskStatus` — DONE/CLOSED/
 * COMPLETED), formatted as `id (STATUS)` strings. A child id the task service
 * cannot resolve to a readable record is also treated as incomplete
 * (`id (unreadable)`), since it can't be verified complete. Returns `[]` when
 * the task has no children.
 *
 * Shared core for both children-completeness closeout guards below:
 * `assertUmbrellaChildrenComplete` (mt#2606, umbrella → COMPLETED) and
 * `assertChildrenCompleteForDone` (mt#1649, any kind → DONE).
 */
async function findIncompleteChildren(args: {
  taskId: string;
  taskService: Pick<TaskServiceInterface, "getTasks">;
  taskGraphService: Pick<TaskGraphService, "listChildren">;
}): Promise<string[]> {
  const { taskId, taskService, taskGraphService } = args;
  const childIds = await taskGraphService.listChildren(taskId);
  if (childIds.length === 0) return [];
  const children = await taskService.getTasks(childIds);
  const foundIds = new Set(children.map((c) => c.id));
  return [
    ...children.filter((c) => !isTerminalTaskStatus(c.status)).map((c) => `${c.id} (${c.status})`),
    // A child id with no readable task record cannot be verified complete.
    ...childIds.filter((id) => !foundIds.has(id)).map((id) => `${id} (unreadable)`),
  ];
}

/**
 * Umbrella closeout guard (mt#2606): an umbrella task completes when its
 * children complete, so a transition to COMPLETED is refused while any child
 * is non-terminal (terminal = DONE/CLOSED/COMPLETED), naming the incomplete
 * children. No-op for non-umbrella kinds, non-COMPLETED targets, or when no
 * taskGraphService is available (the MCP/CLI surfaces always inject one;
 * direct domain callers without it keep prior behavior).
 *
 * Shared by the live `setTaskStatusFromParams` facade in
 * `packages/domain/src/tasks.ts` (what the `@minsky/domain/tasks` barrel
 * resolves to) and the transition-validating implementation below.
 *
 * See `assertChildrenCompleteForDone` for the DONE-target, any-kind sibling
 * guard (mt#1649) that generalizes this pattern.
 */
export async function assertUmbrellaChildrenComplete(args: {
  taskId: string;
  taskKind: string | undefined;
  targetStatus: string;
  taskService: Pick<TaskServiceInterface, "getTasks">;
  taskGraphService?: Pick<TaskGraphService, "listChildren">;
}): Promise<void> {
  const { taskId, taskKind, targetStatus, taskService, taskGraphService } = args;
  if (taskKind !== "umbrella" || targetStatus !== TaskStatus.COMPLETED || !taskGraphService) {
    return;
  }
  const incomplete = await findIncompleteChildren({ taskId, taskService, taskGraphService });
  if (incomplete.length > 0) {
    throw new ValidationError(
      `Cannot complete umbrella task ${taskId}: ${incomplete.length} child task(s) not terminal (DONE/CLOSED/COMPLETED): ${incomplete.join(", ")}. Complete or close the children first (mt#2606).`,
      undefined,
      undefined
    );
  }
}

/**
 * Parent-rollup-completion guard (mt#1649): generalizes the mt#2606 umbrella
 * pattern (injected `taskGraphService` + `isTerminalTaskStatus`) to the DONE
 * target across ALL task kinds — not just umbrella → COMPLETED. Refuses a
 * transition to DONE on a task that HAS children while any child is
 * non-terminal (terminal = DONE/CLOSED/COMPLETED), naming the incomplete
 * children. Childless tasks transitioning to DONE are unaffected, and the
 * guard is a no-op when no `taskGraphService` is available (same fail-open
 * shape as `assertUmbrellaChildrenComplete` — the MCP/CLI surfaces always
 * inject one; direct domain callers without it keep prior behavior).
 *
 * Originating incident: mt#1503 was set DONE while its lynchpin child
 * (mt#1073) sat at PLANNING. See `docs/task-kinds.md` "Parent-DONE guard"
 * for the pinned regression shape.
 */
export async function assertChildrenCompleteForDone(args: {
  taskId: string;
  targetStatus: string;
  taskService: Pick<TaskServiceInterface, "getTasks">;
  taskGraphService?: Pick<TaskGraphService, "listChildren">;
}): Promise<void> {
  const { taskId, targetStatus, taskService, taskGraphService } = args;
  if (targetStatus !== TaskStatus.DONE || !taskGraphService) {
    return;
  }
  const incomplete = await findIncompleteChildren({ taskId, taskService, taskGraphService });
  if (incomplete.length > 0) {
    throw new ValidationError(
      `Cannot set task ${taskId} to DONE: ${incomplete.length} child task(s) not terminal (DONE/CLOSED/COMPLETED): ${incomplete.join(", ")}. Resolve one of:\n` +
        `  1. Set the children to DONE (or CLOSED/COMPLETED) first.\n` +
        `  2. Amend the parent's success criteria if scope was reframed.\n` +
        `  3. Walk the parent through CLOSED if the rollup is being abandoned.\n` +
        `(mt#1649)`,
      undefined,
      undefined
    );
  }
}

/**
 * Set task status using the provided parameters
 */
export async function setTaskStatusFromParams(
  params: TaskStatusSetParams,
  deps?: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
    taskGraphService?: Pick<TaskGraphService, "listChildren">;
  }
): Promise<void> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusSetParamsSchema.parse(paramsWithQualifiedId);

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      const workspacePath =
        (await deps?.resolveMainWorkspacePath?.()) ??
        (await (deps?.resolveRepoPath || resolveRepoPath)({
          session: validParams.session,
          repo: validParams.repo,
        }));

      taskService = deps?.createConfiguredTaskService
        ? await deps.createConfiguredTaskService({
            workspacePath,
            backend: validParams.backend,
          })
        : await createConfiguredTaskServiceImpl({
            workspacePath,
            backend: validParams.backend,
            persistenceProvider: requirePersistence(deps?.persistenceProvider),
          });
    }

    // Verify the task exists before setting status and get old status for commit message
    const task = await taskService.getTask(validParams.taskId);

    if (!task || !task.id) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    // Validate the status transition. A falsy current status indicates a backend bug —
    // refuse to transition rather than silently skipping validation (mt#1504 ride-along).
    if (!task.status) {
      throw new ValidationError(
        `Task ${validParams.taskId} has no current status — backend returned an empty/missing status field. Refusing to set status until the read returns a valid value.`,
        undefined,
        undefined
      );
    }

    // READY → DONE requires a ## Closeout evidence section with non-empty content.
    // This path is for external-deliverable tasks that complete without a PR merge.
    // See .minsky/rules/task-lifecycle-external-deliverable.mdc (or the compiled CLAUDE.md section) for the convention.
    if (task.status === TaskStatus.READY && validParams.status === TaskStatus.DONE) {
      let specContent = "";
      try {
        const specResult = await taskService.getTaskSpecContent(validParams.taskId);
        specContent = specResult.content ?? "";
      } catch {
        // If spec cannot be read, treat as missing — the check will fail below.
        specContent = "";
      }
      if (!hasCloseoutEvidence(specContent)) {
        throw new ValidationError(READY_TO_DONE_MISSING_EVIDENCE_MESSAGE, undefined, undefined);
      }
    }

    // Umbrella closeout guard (mt#2606) — see assertUmbrellaChildrenComplete.
    await assertUmbrellaChildrenComplete({
      taskId: validParams.taskId,
      taskKind: task.kind,
      targetStatus: validParams.status,
      taskService,
      taskGraphService: deps?.taskGraphService,
    });

    // Parent-rollup-completion guard (mt#1649) — see assertChildrenCompleteForDone.
    await assertChildrenCompleteForDone({
      taskId: validParams.taskId,
      targetStatus: validParams.status,
      taskService,
      taskGraphService: deps?.taskGraphService,
    });

    // Pass task.kind so the gate dispatches to the right per-kind workflow (mt#1812).
    // task.kind defaults to "implementation" when unset (backward-compat).
    validateStatusTransition(
      task.status as TaskStatus,
      validParams.status as TaskStatus,
      task.kind
    );

    // Set the task status
    await taskService.setTaskStatus(validParams.taskId, validParams.status);

    // Auto-commit functionality was removed - no backend-specific handling needed
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for setting task status",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}

/**
 * Update a task using the provided parameters
 */
export async function updateTaskFromParams(
  params: {
    taskId: string;
    title?: string;
    spec?: string;
    repo?: string;
    workspace?: string;
    session?: string;
    backend?: string;
  },
  deps?: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      const workspacePath =
        (await deps?.resolveMainWorkspacePath?.()) ??
        (await (deps?.resolveRepoPath || resolveRepoPath)({
          session: params.session,
          repo: params.repo,
        }));

      taskService = deps?.createConfiguredTaskService
        ? await deps.createConfiguredTaskService({
            workspacePath,
            backend: params.backend,
          })
        : await createConfiguredTaskServiceImpl({
            workspacePath,
            backend: params.backend,
            persistenceProvider: requirePersistence(deps?.persistenceProvider),
          });
    }

    // Verify the task exists before updating
    const existingTask = await taskService.getTask(qualifiedTaskId);

    if (!existingTask || !existingTask.id) {
      throw new ResourceNotFoundError(`Task ${qualifiedTaskId} not found`, "task", qualifiedTaskId);
    }

    // Prepare updates object
    const updates: Partial<Task> = {};
    if (params.title !== undefined) {
      updates.title = params.title;
    }

    // Update the task
    const updatedTask = await taskService.updateTask?.(qualifiedTaskId, updates);

    if (!updatedTask) {
      throw new Error(`Failed to update task ${qualifiedTaskId}: updateTask returned no result`);
    }
    return updatedTask;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for updating task",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}

/**
 * Create a task using the provided parameters
 */
export async function createTaskFromParams(
  params: TaskCreateParams,
  deps: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
  } = {
    resolveRepoPath,
  }
): Promise<Task> {
  try {
    // Validate params with Zod schema
    const validParams = taskCreateParamsSchema.parse(params);

    // Use DI-provided taskService when available
    let taskService = deps.taskService;
    if (!taskService) {
      const resolveRepo = deps.resolveRepoPath || resolveRepoPath;
      const workspacePath = await resolveRepo({
        session: validParams.session,
        repo: validParams.repo,
      });

      taskService = deps.createConfiguredTaskService
        ? await deps.createConfiguredTaskService({
            workspacePath,
            backend: validParams.backend,
          })
        : await createConfiguredTaskServiceImpl({
            workspacePath,
            backend: validParams.backend,
            persistenceProvider: requirePersistence(deps.persistenceProvider),
          });
    }

    // Validate kind against the workflow registry when provided. Invalid kinds are
    // rejected up front rather than allowed to silently default at the backend layer
    // (which would mask a typo as a successful default-to-implementation create).
    if (validParams.kind !== undefined && !isKnownKind(validParams.kind)) {
      const known = Object.keys(WORKFLOWS).join(", ");
      throw new ValidationError(`Unknown task kind: "${validParams.kind}". Valid kinds: ${known}.`);
    }

    // Create the task from title and spec content
    const specContent = validParams.spec || validParams.description || "";
    const task = await taskService.createTaskFromTitleAndSpec(validParams.title, specContent, {
      force: validParams.force,
      tags: validParams.tags,
      kind: validParams.kind,
      // Pass backend so the multi-backend service routes to the caller's requested backend
      // instead of silently using the wrong default when the preferred backend is down (mt#2572 Bug 4).
      backend: validParams.backend,
    });

    // Auto-commit functionality was removed - no backend-specific handling needed

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for creating task",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}

/**
 * Create a task from title and spec
 */
export async function createTaskFromTitleAndSpec(
  params: TaskCreateFromTitleAndSpecParams,
  deps?: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  // Validate params
  const validParams = taskCreateFromTitleAndSpecParamsSchema.parse(params);

  // Use DI-provided taskService when available
  let taskService = deps?.taskService;
  if (!taskService) {
    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await (deps?.resolveRepoPath || resolveRepoPath)({
        session: validParams.session,
        repo: validParams.repo,
      }));

    taskService = deps?.createConfiguredTaskService
      ? await deps.createConfiguredTaskService({
          workspacePath,
          backend: validParams.backend,
        })
      : await createConfiguredTaskServiceImpl({
          workspacePath,
          backend: validParams.backend,
          persistenceProvider: requirePersistence(deps?.persistenceProvider),
        });
  }

  // Validate kind against the workflow registry when provided.
  if (validParams.kind !== undefined && !isKnownKind(validParams.kind)) {
    const known = Object.keys(WORKFLOWS).join(", ");
    throw new ValidationError(`Unknown task kind: "${validParams.kind}". Valid kinds: ${known}.`);
  }

  // Handle spec content - from spec string only
  const specContent = validParams.spec || "";

  // Create the task from title and spec
  const task = await taskService.createTaskFromTitleAndSpec(validParams.title, specContent, {
    force: validParams.force,
    tags: validParams.tags,
    kind: validParams.kind,
    // Forward backend so the multi-backend service routes to the caller's requested backend
    // on this command-layer path too (not just createTaskFromParams) — mt#2572 Bug 4, R1.
    backend: validParams.backend,
  });

  return task;
}

/**
 * Delete a task using the provided parameters
 */
export async function deleteTaskFromParams(
  params: TaskDeleteParams,
  deps: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
  } = {
    resolveRepoPath,
  }
): Promise<{ success: boolean; taskId: string; task?: Task }> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    const validParams = taskDeleteParamsSchema.parse(paramsWithQualifiedId);

    // Use DI-provided taskService when available
    let taskService = deps.taskService;
    if (!taskService) {
      const resolveRepo = deps.resolveRepoPath || resolveRepoPath;
      const workspacePath = await resolveRepo({
        session: validParams.session,
        repo: validParams.repo,
      });

      taskService = deps.createConfiguredTaskService
        ? await deps.createConfiguredTaskService({
            workspacePath,
            backend: validParams.backend,
          })
        : await createConfiguredTaskServiceImpl({
            workspacePath,
            backend: validParams.backend,
            persistenceProvider: requirePersistence(deps.persistenceProvider),
          });
    }

    // Get the task first to verify it exists and get details for commit message
    const task = await taskService.getTask(validParams.taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    // Delete the task
    const deleted = await taskService.deleteTask(validParams.taskId, {
      force: validParams.force,
    });

    // Auto-commit functionality was removed - no backend-specific handling needed

    return {
      success: deleted,
      taskId: validParams.taskId,
      task: task,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for deleting task",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}
