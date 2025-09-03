/**
 * CLI adapter for task deps commands
 */
import { Command } from "commander";
import { log } from "../../../utils/logger";
import { sharedCommandRegistry } from "../../shared/command-registry";
import { addRepoOptions, addOutputOptions, addBackendOptions } from "../utils/index";
import { handleCliError, outputResult } from "../utils/error-handler";

/**
 * Interface for CLI options specific to the deps commands
 */
interface DepsCommandOptions {
  session?: string;
  repo?: string;
  "upstream-repo"?: string;
  backend?: string;
  json?: boolean;
  verbose?: boolean;
  limit?: number;
  maxDepth?: number;
  status?: string;
}

/**
 * Creates the task deps command with subcommands
 * This provides dependency management and visualization for tasks
 */
export function createDepsCommand(): Command {
  const depsCommand = new Command("deps").description("Manage and visualize task dependencies");

  // Add subcommands
  addDepsAddCommand(depsCommand);
  addDepsRmCommand(depsCommand);
  addDepsListCommand(depsCommand);
  addDepsTreeCommand(depsCommand);
  addDepsGraphCommand(depsCommand);

  return depsCommand;
}

/**
 * Add the 'deps add' subcommand
 */
function addDepsAddCommand(parent: Command): void {
  const addCommand = new Command("add")
    .description("Add a dependency relationship between tasks")
    .argument("<from-task>", "Task that will depend on another task")
    .argument("<to-task>", "Task that is the dependency")
    .option(
      "--type <type>",
      "Type of dependency (prerequisite, related, optional)",
      "prerequisite"
    );

  addRepoOptions(addCommand);
  addOutputOptions(addCommand);
  addBackendOptions(addCommand);

  addCommand.action(async (fromTask: string, toTask: string, options: DepsCommandOptions) => {
    try {
      const command = sharedCommandRegistry.getCommand("tasks.deps.add");
      if (!command) {
        throw new Error("Dependencies add command not available");
      }

      const result = await command.execute({
        task: fromTask,
        dependsOn: toTask,
        type: (options as any).type || "prerequisite",
      });

      if (options.json) {
        outputResult(result, { json: true });
      } else {
        // Use the output field from the shared command result
        log.cli(result.output || "✅ Success");
      }
    } catch (error) {
      handleCliError(error);
    }
  });

  parent.addCommand(addCommand);
}

/**
 * Add the 'deps rm' subcommand
 */
function addDepsRmCommand(parent: Command): void {
  const rmCommand = new Command("rm")
    .description("Remove a dependency relationship between tasks")
    .argument("<from-task>", "Task that depends on another task")
    .argument("<to-task>", "Task that is the dependency");

  addRepoOptions(rmCommand);
  addOutputOptions(rmCommand);
  addBackendOptions(rmCommand);

  rmCommand.action(async (fromTask: string, toTask: string, options: DepsCommandOptions) => {
    try {
      const command = sharedCommandRegistry.getCommand("tasks.deps.rm");
      if (!command) {
        throw new Error("Dependencies remove command not available");
      }

      const result = await command.execute({
        task: fromTask,
        dependsOn: toTask,
      });

      if (options.json) {
        outputResult(result, { json: true });
      } else {
        // Use the output field from the shared command result
        log.info(result.output || "✅ Success");
      }
    } catch (error) {
      handleCliError(error);
    }
  });

  parent.addCommand(rmCommand);
}

/**
 * Add the 'deps list' subcommand
 */
function addDepsListCommand(parent: Command): void {
  const listCommand = new Command("list")
    .description("List dependencies for a specific task")
    .argument("<task-id>", "ID of the task to list dependencies for");

  addRepoOptions(listCommand);
  addOutputOptions(listCommand);
  addBackendOptions(listCommand);

  listCommand.action(async (taskId: string, options: DepsCommandOptions) => {
    try {
      const command = sharedCommandRegistry.getCommand("tasks.deps.list");
      if (!command) {
        throw new Error("Dependencies list command not available");
      }

      const result = await command.execute({
        task: taskId,
      });

      if (options.json) {
        outputResult(result, { json: true });
      } else {
        // Format the output nicely for console display
        log.info(result.output || "No dependencies found");
      }
    } catch (error) {
      handleCliError(error);
    }
  });

  parent.addCommand(listCommand);
}

/**
 * Add the 'deps tree' subcommand
 */
function addDepsTreeCommand(parent: Command): void {
  const treeCommand = new Command("tree")
    .description("Show dependency tree for a specific task")
    .argument("<task-id>", "ID of the task to show dependency tree for")
    .option("--max-depth <depth>", "Maximum depth to traverse", "3");

  addRepoOptions(treeCommand);
  addOutputOptions(treeCommand);
  addBackendOptions(treeCommand);

  treeCommand.action(
    async (taskId: string, options: DepsCommandOptions & { maxDepth?: string }) => {
      try {
        const command = sharedCommandRegistry.getCommand("tasks.deps.tree");
        if (!command) {
          throw new Error("Dependencies tree command not available");
        }

        const result = await command.execute({
          task: taskId,
          maxDepth: options.maxDepth ? parseInt(options.maxDepth, 10) : 3,
        });

        if (options.json) {
          outputResult(result, { json: true });
        } else {
          // Display the tree output directly
          log.info(result.output || "No dependency tree available");
        }
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  parent.addCommand(treeCommand);
}

/**
 * Add the 'deps graph' subcommand
 */
function addDepsGraphCommand(parent: Command): void {
  const graphCommand = new Command("graph")
    .description("Show task dependency graph")
    .option("--limit <limit>", "Maximum number of tasks to include", "20")
    .option("--status <status>", "Filter tasks by status", "TODO")
    .option("--format <format>", "Output format: ascii, dot, svg, png, pdf", "ascii")
    .option("--output <file>", "Output file path (auto-generated for rendered formats)");

  addRepoOptions(graphCommand);
  addOutputOptions(graphCommand);
  addBackendOptions(graphCommand);

  graphCommand.action(
    async (options: DepsCommandOptions & { limit?: string; format?: string; output?: string }) => {
      try {
        const command = sharedCommandRegistry.getCommand("tasks.deps.graph");
        if (!command) {
          throw new Error("Dependencies graph command not available");
        }

        const result = await command.execute({
          limit: options.limit ? parseInt(options.limit, 10) : 20,
          status: options.status,
          format: options.format || "ascii",
          output: options.output,
        });

        if (options.json) {
          outputResult(result, { json: true });
        } else {
          // Display the graph output directly
          log.info(result.output || "No dependency graph available");
        }
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  parent.addCommand(graphCommand);
}
