import { Command } from "commander";
import { createTasksRouteCommand } from "../../shared/commands/tasks/routing-commands";
import { log } from "../../../utils/logger";
import { handleCliError } from "../utils/error-handler";

/**
 * Create the tasks route command
 */
export function createRouteCommand(): Command {
  const routeCommand = createTasksRouteCommand();
  const command = new Command("route");

  command
    .description("Generate implementation route to target task")
    .argument("<target>", "Target task ID to generate route for")
    .option(
      "--strategy <strategy>",
      "Routing strategy: ready-first, shortest-path, value-first",
      "ready-first"
    )
    .option("--parallel", "Show parallel execution opportunities")
    .option("--json", "Output in JSON format");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Commander.js action callback receives dynamically-typed options object
  command.action(async (target: string, options: any) => {
    try {
      const result = await routeCommand.execute({
        target,
        strategy: options.strategy,
        parallel: options.parallel,
        json: options.json,
      });
      if (options.json) {
        log.cli(JSON.stringify(result, null, 2));
      } else {
        log.cli(result.output || "");
      }
    } catch (error) {
      handleCliError(error);
    }
  });

  return command;
}
