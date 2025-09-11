/**
 * Task Spec Command - DatabaseCommand Migration
 *
 * This command migrates from the old pattern (using PersistenceService.getProvider() via domain layer)
 * to the new DatabaseCommand pattern with automatic provider injection.
 *
 * MIGRATION NOTES:
 * - OLD: Extended BaseTaskCommand, used getTaskSpecContentFromParams that internally calls PersistenceService.getProvider()
 * - NEW: Extends DatabaseCommand, passes injected provider to domain function via createConfiguredTaskService
 * - BENEFIT: No singleton access, proper dependency injection, lazy initialization
 */

import {
  DatabaseCommand,
  DatabaseCommandContext,
} from "../../../../domain/commands/database-command";
import { CommandCategory } from "../../command-registry";
import { getTaskSpecContentFromParams } from "../../../../domain/tasks";
import { ValidationError } from "../../../../errors/index";
import { tasksSpecParams } from "./task-parameters";

/**
 * Task spec command - migrated to DatabaseCommand
 *
 * Retrieves task specification content from various backends.
 */
export class TasksSpecCommand extends DatabaseCommand {
  readonly id = "tasks.spec.get";
  readonly category = CommandCategory.TASKS;
  readonly name = "get";
  readonly description = "Get task specification content";
  readonly parameters = tasksSpecParams;

  async execute(
    params: {
      taskId: string;
      section?: string;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      json?: boolean;
    },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;

    if (!params.taskId) {
      throw new ValidationError("taskId is required");
    }

    // Get task specification content - pass provider for dependency injection
    const specResult = await getTaskSpecContentFromParams(
      {
        taskId: params.taskId,
        section: params.section,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
      },
      {
        resolveRepoPath: async (repo) => {
          const { resolveRepoPath } = await import("../../../../domain/workspace");
          return await resolveRepoPath(repo);
        },
        createConfiguredTaskService: async (options) => {
          const { createConfiguredTaskService } = await import(
            "../../../../domain/tasks/taskService"
          );
          return await createConfiguredTaskService({
            ...options,
            persistenceProvider: provider,
          });
        },
      }
    );

    const wantJson = params.json || context.format === "json";
    if (wantJson) {
      return specResult;
    }

    return {
      success: true,
      taskId: params.taskId,
      specPath: specResult.specPath,
      content: specResult.content,
      section: specResult.section,
      task: specResult.task,
      message: `Retrieved specification for task ${params.taskId}`,
    };
  }
}

/**
 * MIGRATION SUMMARY FOR SPEC COMMAND:
 *
 * 1. Changed from BaseTaskCommand to DatabaseCommand
 * 2. Added required category property (CommandCategory.TASKS)
 * 3. Updated execute method to receive DatabaseCommandContext with provider
 * 4. Replaced internal PersistenceService.getProvider() calls with injected provider
 * 5. Updated getTaskSpecContentFromParams call to pass provider via dependency injection
 * 6. Simplified return structures (removed BaseTaskCommand helper methods)
 *
 * BENEFITS:
 * - Automatic provider initialization via CommandDispatcher
 * - Type-safe parameter handling with DatabaseCommand
 * - Clean dependency injection for testing
 * - No manual PersistenceService calls needed
 * - Lazy initialization - no upfront database connections
 * - All spec retrieval functionality preserved
 */
