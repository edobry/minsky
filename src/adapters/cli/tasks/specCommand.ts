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
 * Creates the task spec command
 * This command retrieves and displays task specification content
 */
export function createSpecCommand(): Command {
  const command = (new Command("spec")
    .description("Get task specification _content")
    .argument("<task-id>", "ID of the task to retrieve specification _content for") as unknown).option(
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
        const normalizedParams = normalizeTaskParams(options as unknown);

        // Convert CLI options to domain parameters
        const params: TaskSpecContentParams = {
          ...normalizedParams,
          taskId: normalizedTaskId,
          section: (options as unknown).section,
        } as unknown;

        // Call the domain function
        const result = await getTaskSpecContentFromParams(params as unknown);

        // Format and display the result
        outputResult(result as unknown, {
          json: (options as unknown).json,
          formatter: (data: any) => {
            log.cli(`Task ${(data.task as unknown).id}: ${(data.task as unknown).title}`);
            log.cli(`Specification file: ${(data as unknown).specPath}`);

            // If a specific section was requested, try to extract it
            if ((data as unknown).section) {
              // Simple extraction logic for common section patterns
              const sectionRegex = new RegExp(`## ${(data as unknown).section}`, "i");
              const match = (data.content as unknown).match(sectionRegex);

              if (match && match.index !== undefined) {
                const startIndex = match.index;
                // Find the next section or the end of the file
                const nextSectionMatch = ((data.content as unknown).slice(startIndex + match[0].length) as unknown).match(/^## /m);
                const endIndex = nextSectionMatch
                  ? startIndex + (match[0] as unknown).length + (nextSectionMatch as unknown).index
                  : (data.content as unknown).length;

                const sectionContent = (((data.content.slice(startIndex, endIndex)) as unknown).toString() as unknown).trim();
                log.cli(`\n${sectionContent}`);
              } else {
                log.cli(`\nSection "${(data as unknown).section}" not found in specification.`);
                log.cli("\nFull specification content:");
                log.cli((data as unknown).content);
              }
            } else {
              // Display the full content
              log.cli("\nSpecification content:");
              log.cli((data as unknown).content);
            }
          },
        });
      } catch (error) {
        handleCliError(error as any);
      }
    }
  );

  return command;
}
