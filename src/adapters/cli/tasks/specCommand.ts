/**
 * CLI adapter for task spec command
 */
import { Command } from "commander";
import { log } from "../../../utils/logger";
import { getTaskSpecContentFromParams, normalizeTaskId } from "../../../domain/tasks";
import type { TaskSpecContentParams } from "../../../schemas/tasks";
import { ValidationError } from "../../../errors/index";
import {
  addRepoOptions,
  addOutputOptions,
  addBackendOptions,
  normalizeTaskParams,
} from "../utils/index";
import { handleCliError, outputResult } from "../utils/error-handler";

/**
 * Interface for CLI options specific to the spec command
 */
interface SpecCommandOptions {
  section?: string;
  session?: string;
  repo?: string;
  "upstream-repo"?: string;
  backend?: string;
  json?: boolean;
}

/**
 * Creates the task spec command
 * This command retrieves and displays task specification content
 */
export function createSpecCommand(): Command {
  const command = new Command("spec")
    .description("Get task specification _content")
    .argument("<task-id>", "ID of the task to retrieve specification _content for").option(
      "--section <section>",
      "Specific section of the specification to retrieve (e.g., 'requirements')"
    );

  // Add shared options
  addRepoOptions(command);
  addOutputOptions(command);
  addBackendOptions(command);

  command.action(
    async (
      taskId: string,
      options: SpecCommandOptions
    ) => {
      try {
        // Normalize the task ID before passing to domain
        const normalizedTaskId = normalizeTaskId(taskId);
        if (!normalizedTaskId) {
          throw new ValidationError(
            `Invalid task ID: '${taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
          );
        }

        // Convert CLI options to domain parameters using normalization helper
        const normalizedParams = normalizeTaskParams(options);

        // Convert CLI options to domain parameters
        const params: TaskSpecContentParams = {
          ...normalizedParams,
          taskId: normalizedTaskId,
          section: options.section,
        };

        // Call the domain function
        const result = await getTaskSpecContentFromParams(params);

        // Format and display the result
        outputResult(result, {
          json: options.json,
        });
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  return command;
}
