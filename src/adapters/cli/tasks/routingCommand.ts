import { Command } from "commander";
import {
  createTasksAvailableCommand,
  createTasksRouteCommand,
} from "../../shared/commands/tasks/routing-commands";
import { log } from "../../../utils/logger";
import { handleCliError } from "../utils/error-handler";

export function createRoutingCommand(): Command {
  const routingCommand = new Command("routing");
  routingCommand.description("Task routing and availability commands");

  // Add "available" subcommand
  const availableCommand = createTasksAvailableCommand();
  const availableCmd = new Command("available");
  availableCmd.description(availableCommand.description);

  // Add options for available command
  availableCmd.option("--status <status>", "Filter by task status (default: TODO,IN-PROGRESS)");
  availableCmd.option("--backend <backend>", "Filter by specific backend (mt, md, gh, etc.)");
  availableCmd.option(
    "--limit <number>",
    "Maximum number of tasks to show",
    (v) => parseInt(v),
    20
  );
  availableCmd.option("--show-effort", "Include effort estimates if available");
  availableCmd.option("--show-priority", "Include priority information if available");
  availableCmd.option("--json", "Output in JSON format");
  availableCmd.option(
    "--min-readiness <number>",
    "Minimum readiness score (0.0-1.0)",
    (v) => parseFloat(v),
    0.5
  );

  availableCmd.action(async (options: any) => {
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
  });
  routingCommand.addCommand(availableCmd);

  // Add "route" subcommand
  const routeCommand = createTasksRouteCommand();
  const routeCmd = new Command("route");
  routeCmd.description(routeCommand.description);

  // Add arguments and options for route command
  routeCmd.argument("<target>", "Target task ID to generate route for");
  routeCmd.option(
    "--strategy <strategy>",
    "Routing strategy: ready-first, shortest-path, value-first",
    "ready-first"
  );
  routeCmd.option("--parallel", "Show parallel execution opportunities");
  routeCmd.option("--json", "Output in JSON format");

  routeCmd.action(async (target: string, options: any) => {
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
  routingCommand.addCommand(routeCmd);

  return routingCommand;
}
