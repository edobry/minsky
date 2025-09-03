import { Command } from "commander";
import { createTasksAvailableCommand } from "../../shared/commands/tasks/routing-commands";
import { createCommandHandler } from "../../shared/bridges/cli/command-handler";

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

  command.action(createCommandHandler("tasks.available", availableCommand));

  return command;
}
