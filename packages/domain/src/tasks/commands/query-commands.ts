/**
 * Task Query Commands
 *
 * Interface-agnostic read operations: list, get, getStatus, getSpecContent.
 *
 * Every function here is the canonical implementation the facade
 * (`packages/domain/src/tasks.ts`) delegates to: `listTasksFromParams` (mt#2783,
 * resolving ADR-021 project scope per mt#2416 and forwarding
 * status/kind/tags/projectScope filters to `taskService.listTasks`),
 * `getTaskSpecContentFromParams` (mt#3194, forwarding `section` and doing
 * markdown-heading-range extraction), and `getTaskFromParams` /
 * `getTaskStatusFromParams` (mt#3190, adding taskId normalization and
 * session/repo-aware workspace resolution over the facade's former
 * process.cwd()-only bodies). Both the CLI/MCP resolution path
 * (`@minsky/domain/tasks` → `tasks/index.ts` → `../tasks.ts`, which delegates
 * here) and the `taskCommands.ts` barrel (e.g. `index-embeddings-command.ts`)
 * terminate at these bodies — see `../../tasks.ts`'s header for the full
 * cross-function delegation map.
 */

import { z } from "zod";
import { getErrorMessage, ValidationError, ResourceNotFoundError } from "../../errors/index";
import { log } from "@minsky/shared/logger";
import { isSqlCapable } from "../../persistence/types";
import {
  createConfiguredTaskService as createConfiguredTaskServiceImpl,
  TaskServiceOptions,
  TaskServiceInterface,
  TaskSpecContentResult,
} from "../taskService";
import type { Task } from "../types";
import { first } from "@minsky/shared/array-safety";
import {
  taskListParamsSchema,
  taskGetParamsSchema,
  taskStatusGetParamsSchema,
  taskSpecContentParamsSchema,
  type TaskListParams,
  type TaskGetParams,
  type TaskStatusGetParams,
  type TaskSpecContentParams,
} from "../../schemas/tasks";
import { resolveRepoPath, normalizeTaskIdInput } from "./shared-helpers";
import type { BasePersistenceProvider } from "../../persistence/types";
import { assertKnownKind } from "../workflows";
import { ALL_PROJECTS, type ProjectScope } from "../../project/scope";
import { resolveProjectIdentity } from "../../project/identity";
import { resolveProjectScope } from "../../project/scope-resolver";

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
 * List tasks with given parameters
 * @param params Parameters for listing tasks
 * @param deps Optional dependencies for testing
 * @returns Array of tasks
 */
export async function listTasksFromParams(
  params: TaskListParams,
  deps?: {
    taskService?: TaskServiceInterface;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task[]> {
  try {
    // Validate params with Zod schema
    const validParams = taskListParamsSchema.parse(params);

    // Validate kind against the workflow registry up front (mt#2762) — a typo
    // must not slip through to a backend query that silently returns zero rows.
    assertKnownKind(validParams.kind);

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      // Prefer injected main workspace path for tests; otherwise resolve from repo
      const workspacePath =
        (await deps?.resolveMainWorkspacePath?.()) ??
        (await resolveRepoPath({
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

    // Resolve project scope (ADR-021, mt#2416; ported from the former tasks.ts-only
    // duplicate — mt#2783). allProjects=true skips the scope filter entirely;
    // otherwise resolve per-process identity and fall back to ALL_PROJECTS on any
    // resolution failure.
    //
    // The persistenceProvider/getDatabaseConnection capability check is done
    // FIRST, before touching process.cwd() at all (PR #2281 R1): this function
    // is now reached by non-CLI-entry-point callers too (e.g.
    // index-embeddings-command.ts, via the taskCommands.ts barrel), for whom cwd
    // may be meaningless — they never pass a persistenceProvider, so with the
    // check ordered this way they never invoke resolveProjectIdentity(cwd) at
    // all. CLI/MCP behavior is unchanged: crud-commands.ts always injects a
    // persistenceProvider (registry-setup.ts's getPersistenceProvider either
    // returns one or throws before this function is even called), so the
    // identity resolution still runs on that path exactly as it did in the
    // former tasks.ts-only implementation.
    let projectScope: ProjectScope = ALL_PROJECTS;
    if (!validParams.allProjects) {
      const persistenceProvider = deps?.persistenceProvider;
      // Capability, not method presence (mt#4543). The guard narrows, so the cast and
      // the `?.()` that hedged it are both gone — `getDatabaseConnection` is required on
      // the narrowed type.
      if (isSqlCapable(persistenceProvider)) {
        try {
          const identity = resolveProjectIdentity({ repoPath: process.cwd() });
          if (identity.kind === "resolved") {
            const db = await persistenceProvider.getDatabaseConnection();
            if (db) {
              projectScope = await resolveProjectScope(identity, db, "tasks.list");
            }
          }
        } catch (err) {
          log.debug(
            "[listTasksFromParams] Project scope resolution failed; defaulting to ALL_PROJECTS",
            {
              error: err instanceof Error ? err.message : String(err),
            }
          );
        }
      }
    }

    // Get tasks with filters - delegate filtering to domain layer (server-side;
    // kind/tags/projectScope are forwarded to taskService.listTasks so backends
    // filter server-side rather than the adapter post-filtering the result,
    // mt#2762 / mt#2783).
    let tasks = await taskService.listTasks({
      status: validParams.status,
      all: validParams.all,
      backend: validParams.backend,
      tags: validParams.tags,
      projectScope,
      kind: validParams.kind,
    });
    // Apply limit client-side if provided
    const limit = validParams.limit;
    if (typeof limit === "number" && limit > 0) {
      tasks = tasks.slice(0, limit);
    }
    return tasks;
  } catch (error) {
    log.error(`Error listing tasks: ${getErrorMessage(error)}`);
    throw error;
  }
}

/**
 * Get a task by ID with given parameters
 * @param params Parameters for getting a task
 * @param deps Optional dependencies for testing
 * @returns Task object
 */
export async function getTaskFromParams(
  params: TaskGetParams,
  deps?: {
    taskService?: TaskServiceInterface;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  const startTime = Date.now();
  log.debug("[getTaskFromParams] Starting execution", { params });

  try {
    // Handle taskId as either string or string array and normalize
    const taskIdInput = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
    log.debug("[getTaskFromParams] Processed taskId input", { taskIdInput });

    if (!taskIdInput) {
      throw new ValidationError("Task ID is required");
    }

    const qualifiedTaskId = normalizeTaskIdInput(taskIdInput);
    log.debug("[getTaskFromParams] Using taskId", { taskId: qualifiedTaskId });

    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    log.debug("[getTaskFromParams] About to validate params with Zod");
    const validParams = taskGetParamsSchema.parse(paramsWithQualifiedId);
    log.debug("[getTaskFromParams] Params validated", { validParams });

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      const workspacePath = await (deps?.resolveMainWorkspacePath
        ? deps.resolveMainWorkspacePath()
        : resolveRepoPath({ session: validParams.session, repo: validParams.repo }));
      log.debug("[getTaskFromParams] Using workspace path", { workspacePath });

      log.debug("[getTaskFromParams] About to create task service");
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
    log.debug("[getTaskFromParams] Task service created");

    // Get the task
    log.debug("[getTaskFromParams] About to get task");
    const taskIdStr = Array.isArray(validParams.taskId)
      ? first(validParams.taskId, "taskId array")
      : validParams.taskId;
    const task = await taskService.getTask(taskIdStr);
    log.debug("[getTaskFromParams] Task retrieved", { taskExists: !!task });

    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskIdStr} not found`, "task", taskIdStr);
    }

    const duration = Date.now() - startTime;
    log.debug("[getTaskFromParams] Execution completed", { duration });
    return task;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error("[getTaskFromParams] Error getting task:", {
      error: getErrorMessage(error),
      duration,
    });
    throw error;
  }
}

/**
 * Get task status using the provided parameters
 */
export async function getTaskStatusFromParams(
  params: TaskStatusGetParams,
  deps?: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<string> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusGetParamsSchema.parse(paramsWithQualifiedId);

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

    // Get the task
    const task = await taskService.getTask(validParams.taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found or has no status`,
        "task",
        validParams.taskId
      );
    }

    return task.status;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for getting task status",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}

/**
 * Get task specification content using the provided parameters
 */
export async function getTaskSpecContentFromParams(
  params: TaskSpecContentParams,
  deps: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
  } = {
    resolveRepoPath,
  }
): Promise<TaskSpecContentResult> {
  try {
    // Validate params with Zod schema
    const validParams = taskSpecContentParamsSchema.parse(params);

    // Normalize task ID
    const taskIdString = Array.isArray(validParams.taskId)
      ? validParams.taskId[0]
      : validParams.taskId;
    const taskId = taskIdString;

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

    // Delegate to service which reads spec content from the backend
    const result = await taskService.getTaskSpecContent(taskId, validParams.section);

    // If a specific section is requested, extract it. A section name that does
    // not match any `## <heading>` in the spec is an explicit error, never a
    // silent fallback to the full document (mt#3194) — that silent fallback is
    // what let `--section` go unenforced on the live CLI/MCP path for as long
    // as it did: the envelope echoed `section` back while quietly returning
    // everything.
    let sectionContent = result.content;
    if (validParams.section) {
      const section = validParams.section;
      const lines = (result.content ?? "").toString().split("\n");
      const sectionStart = lines.findIndex((line) =>
        line.toLowerCase().startsWith(`## ${section.toLowerCase()}`)
      );

      if (sectionStart === -1) {
        throw new ResourceNotFoundError(
          `Section "${section}" not found in spec for task ${taskId}`,
          "task-spec-section",
          `${taskId}#${section}`
        );
      }

      let sectionEnd = lines.length;
      for (let i = sectionStart + 1; i < lines.length; i++) {
        if (lines[i]?.startsWith("## ")) {
          sectionEnd = i;
          break;
        }
      }
      sectionContent = lines.slice(sectionStart, sectionEnd).join("\n").trim();
    }

    return {
      task: result.task,
      specPath: result.specPath,
      content: sectionContent,
      // Spec-CONTENT timestamp, threaded through unchanged (mt#4415). Note it
      // describes the WHOLE spec even when `section` narrowed the content —
      // per-section timestamps do not exist, and a section read is still a read
      // of a document last written at this instant.
      specUpdatedAt: result.specUpdatedAt,
      // Spec AUTHORING timestamp, threaded the same way (mt#4420). The
      // whole-document caveat above applies to it identically: it dates the
      // document, not the section, which is precisely why it can serve as a
      // drift floor that editing one section does not move.
      specCreatedAt: result.specCreatedAt,
      section: validParams.section,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for getting task specification",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}
