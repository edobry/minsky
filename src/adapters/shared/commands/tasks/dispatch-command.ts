/**
 * Task Dispatch Command
 *
 * Composes subtask creation + session start + prompt generation into
 * a single MCP tool for streamlined subagent dispatch.
 */
import { z } from "zod";
import type { PersistenceProvider } from "../../../../domain/persistence/types";
import type { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { type CommandParameterMap, type InferParams } from "../../command-registry";
import {
  detectAgentHarness,
  hasNativeSubagentSupport,
} from "../../../../domain/runtime/harness-detection";
import { log } from "../../../../utils/logger";

const tasksDispatchParams = {
  title: {
    schema: z.string(),
    description: "Title for the new subtask",
    required: true,
  },
  instructions: {
    schema: z.string(),
    description: "Work instructions for the subagent",
    required: true,
  },
  parentTaskId: {
    schema: z.string().optional(),
    description: "Parent task ID — creates a subtask. Omit for a root task.",
    required: false,
  },
  type: {
    schema: z
      .enum(["implementation", "refactor", "review", "cleanup", "audit"])
      .default("implementation"),
    description: "Prompt type for the subagent",
    required: false,
  },
  scope: {
    schema: z.string().optional(),
    description: "Comma-separated file paths to constrain the subagent to",
    required: false,
  },
  description: {
    schema: z.string().optional(),
    description: "Task description/spec content",
    required: false,
  },
} satisfies CommandParameterMap;

interface DispatchParams {
  title: string;
  instructions: string;
  parentTaskId?: string;
  type: "implementation" | "refactor" | "review" | "cleanup" | "audit";
  scope?: string;
  description?: string;
}

export function createTasksDispatchCommand(
  getPersistenceProvider: () => PersistenceProvider,
  getSessionProvider: () => Promise<
    import("../../../../domain/session/types").SessionProviderInterface
  >,
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => import("../../../../domain/tasks/taskService").TaskServiceInterface
) {
  return {
    id: "tasks.dispatch",
    name: "dispatch",
    description:
      "Create a subtask, start a session, and generate a subagent prompt — all in one call",
    parameters: tasksDispatchParams,
    execute: async (params: InferParams<typeof tasksDispatchParams>) => {
      const p = params as DispatchParams;
      const harness = detectAgentHarness();

      if (!hasNativeSubagentSupport()) {
        return {
          success: false,
          error:
            `Standalone agent loop not yet available. ` +
            `Detected harness: "${harness}". ` +
            `This tool currently requires Claude Code for subagent dispatch.`,
          harness,
        };
      }

      // Step 1: Create the task
      log.debug("[tasks.dispatch] Creating task", { title: p.title, parent: p.parentTaskId });
      const { createTaskFromTitleAndSpec } = await import("../../../../domain/tasks");
      const taskResult = await createTaskFromTitleAndSpec(
        {
          title: p.title,
          spec: p.description || p.instructions,
          workspace: process.cwd(),
        },
        { persistenceProvider: getPersistenceProvider() }
      );

      const taskId = taskResult.id;
      log.debug("[tasks.dispatch] Task created", { taskId });

      // Step 2: Add parent edge if parentTaskId provided
      if (p.parentTaskId) {
        try {
          const service = getTaskGraphService();
          await service.addParent(taskId, p.parentTaskId);
          log.debug("[tasks.dispatch] Parent edge added", { taskId, parent: p.parentTaskId });
        } catch (err) {
          log.warn(`[tasks.dispatch] Failed to set parent: ${err}`);
        }
      }

      // Step 3: Start a session for the task
      log.debug("[tasks.dispatch] Starting session", { taskId });
      const { SessionService } = await import("../../../../domain/session/session-service");
      const { createGitService } = await import("../../../../domain/git");
      const { createWorkspaceUtils } = await import("../../../../domain/workspace");
      const { getRepositoryBackendFromConfig } = await import(
        "../../../../domain/session/repository-backend-detection"
      );
      const { getCurrentSession } = await import("../../../../domain/workspace");
      const { execAsync } = await import("../../../../utils/exec");
      const dispatchSessionProvider = await getSessionProvider();
      const gitService = createGitService();
      const taskService = getTaskService();

      const service = new SessionService({
        sessionProvider: dispatchSessionProvider,
        gitService,
        taskService,
        workspaceUtils: createWorkspaceUtils(dispatchSessionProvider),
        getCurrentSession: async (repoPath: string) =>
          (await getCurrentSession(repoPath, execAsync, dispatchSessionProvider)) ?? null,
        getRepositoryBackend: getRepositoryBackendFromConfig,
      });

      const sessionResult = await service.start({
        task: taskId,
        quiet: true,
        skipInstall: false,
        noStatusUpdate: false,
      });

      if (!sessionResult?.session) {
        return {
          success: false,
          error: `Task ${taskId} created but session start failed`,
          taskId,
          harness,
        };
      }

      const sessionId =
        typeof sessionResult.session === "string" ? sessionResult.session : sessionResult.session;
      log.debug("[tasks.dispatch] Session started", { sessionId });

      // Step 4: Generate the subagent prompt
      log.debug("[tasks.dispatch] Generating prompt", { taskId, type: p.type });
      const { generateSubagentPrompt } = await import(
        "../../../../domain/session/prompt-generation"
      );
      const { resolveSessionDirectory } = await import(
        "../../../../domain/session/resolve-session-directory"
      );

      const sessionProvider = dispatchSessionProvider;
      const sessionDir = await resolveSessionDirectory(sessionId, sessionProvider);
      const plainTaskId = taskId.replace(/^mt#/, "").replace(/^#/, "");

      const scope = p.scope
        ? p.scope
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => (s.startsWith("/") ? s : `${sessionDir}/${s}`))
        : undefined;

      const promptResult = generateSubagentPrompt({
        sessionDir,
        sessionId,
        taskId: plainTaskId,
        type: p.type,
        instructions: p.instructions,
        scope,
      });

      return {
        success: true,
        taskId,
        parentTaskId: p.parentTaskId,
        sessionId,
        sessionDir,
        harness,
        prompt: promptResult.prompt,
        suggestedModel: promptResult.suggestedModel,
        suggestedSubagentType: promptResult.suggestedSubagentType,
        scopeWarning: promptResult.scopeWarning,
        batches: promptResult.batches,
      };
    },
  };
}
