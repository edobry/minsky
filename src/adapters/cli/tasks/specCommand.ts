/**
 * CLI adapter for task spec command
 */
import { Command } from "commander";
import { log } from "../../../utils/logger";
import { getTaskSpecContentFromParams } from "../../../domain/tasks";
import type { TaskSpecParameters } from "../../../domain/schemas";
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
    .argument("<task-id>", "ID of the task to retrieve specification _content for")
    .option(
      "--section <section>",
      "Specific section of the specification to retrieve (e.g., 'requirements')"
    );

  // Add shared options
  addRepoOptions(command);
  addOutputOptions(command);
  addBackendOptions(command);

  command.action(async (taskId: string, options: SpecCommandOptions) => {
    try {
      // Strict mode: use taskId directly (must be qualified)

      // Convert CLI options to domain parameters using normalization helper
      const normalizedParams = normalizeTaskParams(options);

      // Convert CLI options to domain parameters
      const params: TaskSpecParameters = {
        ...normalizedParams,
        taskId,
        section: options.section,
        debug: false,
        format: options.json ? "json" : "text",
        quiet: false,
        force: false,
      };

      // Call the domain function
      const result = await getTaskSpecContentFromParams(params);

      // Format and display the result
      if (options.json) {
        outputResult(result, {
          json: true,
        });
      } else {
        // For non-JSON output, just print the content with proper newlines
        console.log(result.content);
      }
    } catch (error) {
      handleCliError(error);
    }
  });

  return command;
}
