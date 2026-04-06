import { Command } from "commander";
import { createTasksAvailableCommand } from "../../shared/commands/tasks/routing-commands";
import { log } from "../../../utils/logger";
import { handleCliError } from "../utils/error-handler";

/**
 * Create the tasks available command
 */
export function createAvailableCommand(): Command {
  const availableCommand = createTasksAvailableCommand();
  const command = new Command("available");

  command
    .description("Show tasks currently available to work on (unblocked by dependencies)")
    .option("--status <status>", "Filter by task status (default: TODO,IN-PROGRESS)")
    .option("--backend <backend>", "Filter by specific backend (mt, md, gh, etc.)")
    .option("--limit <number>", "Maximum number of tasks to show", (v) => parseInt(v), 20)
    .option("--show-effort", "Include effort estimates if available")
    .option("--show-priority", "Include priority information if available")
    .option("--json", "Output in JSON format")
    .option(
      "--min-readiness <number>",
      "Minimum readiness score (0.0-1.0)",
      (v) => parseFloat(v),
      0.5
    );

  command.action(
    async (options: {
      status?: string;
      backend?: string;
      limit: number;
      showEffort: boolean;
      showPriority: boolean;
      json: boolean;
      minReadiness: number;
    }) => {
      try {
        const result = await availableCommand.execute({
          status: options.status,
          backend: options.backend,
          limit: options.limit,
          showEffort: options.showEffort,
          showPriority: options.showPriority,
          json: options.json,
          minReadiness: options.minReadiness,
        });
        if (options.json) {
          log.cli(JSON.stringify(result, null, 2));
        } else {
          log.cli(result.output || "");
        }
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  return command;
}
