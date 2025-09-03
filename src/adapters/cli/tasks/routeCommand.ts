import { Command } from "commander";
import { createTasksRouteCommand } from "../../shared/commands/tasks/routing-commands";
import { createCommandHandler } from "../../shared/bridges/cli/command-handler";

/**
 * Create the tasks route command
 */
export function createRouteCommand(): Command {
  const routeCommand = createTasksRouteCommand();
  const command = new Command("route");
  
  command
    .description("Generate implementation route to target task")
    .argument("<target>", "Target task ID to generate route for")
    .option("--strategy <strategy>", "Routing strategy: ready-first, shortest-path, value-first", "ready-first")
    .option("--parallel", "Show parallel execution opportunities")
    .option("--json", "Output in JSON format");

  command.action(createCommandHandler("tasks.route", routeCommand));
  
  return command;
}
