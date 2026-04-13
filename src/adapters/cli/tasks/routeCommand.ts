import { Command } from "commander";
import { PersistenceService } from "../../../domain/persistence/service";
import { createTasksRouteCommand } from "../../shared/commands/tasks/routing-commands";
import { log } from "../../../utils/logger";
import { handleCliError } from "../utils/error-handler";

/**
 * Create the tasks route command
 */
export function createRouteCommand(): Command {
  const routeCommand = createTasksRouteCommand(() => PersistenceService.getProvider());
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

  command.action(
    async (target: string, options: { strategy: string; parallel: boolean; json: boolean }) => {
      try {
        const result = await routeCommand.execute({
          target,
          strategy: options.strategy as "shortest-path" | "value-first" | "ready-first",
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
    }
  );

  return command;
}
