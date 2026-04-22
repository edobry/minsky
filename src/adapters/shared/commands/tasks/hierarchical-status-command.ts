/**
 * Hierarchical Task Status Command
 *
 * Implements proper command hierarchy: tasks -> status -> get/set
 * Replaces the space-separated parsing approach with true hierarchical nesting.
 */
import { Command } from "commander";
import { type CommandExecutionContext } from "../../command-registry";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import { TasksStatusGetCommand, TasksStatusSetCommand } from "./status-commands";
import type { PersistenceProvider } from "../../../../domain/persistence/types";

/**
 * Hierarchical status command that manages get/set subcommands
 */
export class TasksStatusCommand extends BaseTaskCommand<BaseTaskParams> {
  readonly id = "tasks.status";
  readonly name = "status";
  readonly description = "Task status operations";
  readonly parameters = {}; // No direct parameters - subcommands handle their own

  private statusGetCommand: TasksStatusGetCommand;
  private statusSetCommand: TasksStatusSetCommand;

  constructor(private readonly getPersistenceProvider: () => PersistenceProvider) {
    super();
    this.statusGetCommand = new TasksStatusGetCommand(getPersistenceProvider);
    this.statusSetCommand = new TasksStatusSetCommand(getPersistenceProvider);
  }

  async execute(
    params: BaseTaskParams,
    ctx: CommandExecutionContext
  ): Promise<Record<string, unknown>> {
    // This method won't be called directly since we have subcommands
    // But we need it for the interface
    throw new Error("Use 'get' or 'set' subcommands");
  }

  /**
   * Create the hierarchical command structure using Commander.js
   */
  createCommanderCommand(): Command {
    const statusCmd = new Command(this.name).description(this.description);

    // Add 'get' subcommand
    const getCmd = new Command("get")
      .description(this.statusGetCommand.description)
      .argument("<taskId>", "Task ID to get status for")
      .option("--json", "Output as JSON")
      .action(async (taskId: string, options: { json?: boolean }) => {
        const params = {
          taskId,
          json: options.json,
        };
        await this.statusGetCommand.execute(params, {} as CommandExecutionContext);
      });

    // Add 'set' subcommand
    const setCmd = new Command("set")
      .description(this.statusSetCommand.description)
      .argument("<taskId>", "Task ID to set status for")
      .argument("[status]", "Status to set (will prompt if not provided)")
      .option("--json", "Output as JSON")
      .action(async (taskId: string, status: string | undefined, options: { json?: boolean }) => {
        const params = {
          taskId,
          status,
          json: options.json,
        };
        await this.statusSetCommand.execute(params, {} as CommandExecutionContext);
      });

    // Add subcommands to status command
    statusCmd.addCommand(getCmd);
    statusCmd.addCommand(setCmd);

    return statusCmd;
  }
}

/**
 * Factory function for creating the hierarchical status command
 */
export const createTasksStatusCommand = (
  getPersistenceProvider: () => PersistenceProvider
): TasksStatusCommand => new TasksStatusCommand(getPersistenceProvider);
