/**
 * CLI adapter for task spec command
 */
import { Command } from "commander";
import { log } from "../../../utils/logger.js";
import { getTaskSpecContentFromParams, normalizeTaskId } from "../../../domain/tasks.js";
import type { TaskSpecContentParams } from "../../../schemas/tasks.js";
import { ValidationError } from "../../../errors/index.js";
import {
  addRepoOptions,
  addOutputOptions,
  addBackendOptions,
  normalizeTaskParams,
} from "../utils/index.js";
import { handleCliError, outputResult } from "../utils/error-handler.js";

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

  command.action(
    async (
      taskId: string,
      options: {
        section?: string;
        session?: string;
        repo?: string;
        "upstream-repo"?: string;
        backend?: string;
        json?: boolean;
      }
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
        } as any;

        // Call the domain function
        const result = await getTaskSpecContentFromParams(params);

        // Format and display the result
        outputResult(result, {
          json: options.json,
          formatter: (data: any) => {
            log.cli(`Task ${data.task.id}: ${data.task.title}`);
            log.cli(`Specification file: ${data.specPath}`);

            // If a specific section was requested, try to extract it
            if (data.section) {
              // Simple extraction logic for common section patterns
              const sectionRegex = new RegExp(`## ${data.section}`, "i");
              const match = data.content.match(sectionRegex);

              if (match && match.index !== undefined) {
                const startIndex = match.index;
                // Find the next section or the end of the file
                const nextSectionMatch = data.content
                  .slice(startIndex + match[0].length)
                  .match(/^## /m);
                const endIndex = nextSectionMatch
                  ? startIndex + match[0].length + nextSectionMatch.index
                  : data.content.length;

                const sectionContent = (data.content.slice(startIndex, endIndex)).toString().trim();
                log.cli(`\n${sectionContent}`);
              } else {
                log.cli(`\nSection "${data.section}" not found in specification.`);
                log.cli("\nFull specification content:");
                log.cli(data.content);
              }
            } else {
              // Display the full content
              log.cli("\nSpecification content:");
              log.cli(data.content);
            }
          },
        });
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  return command;
}
