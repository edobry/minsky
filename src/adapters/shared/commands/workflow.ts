/**
 * Workflow Commands Registration
 *
 * Registers all workflow-related commands in the shared command registry.
 */

import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import { createWorkflowAssessCommand } from "./workflow/assess-command";
import { createWorkflowInitCommand } from "./workflow/init-command";
import { createWorkflowAddCommand } from "./workflow/add-command";
import { createWorkflowRunCommand } from "./workflow/run-command";
import { createWorkflowListCommand } from "./workflow/list-command";

/**
 * Register all workflow commands in the shared command registry
 */
export function registerWorkflowCommands(): void {
  // Register workflow assess command
  const assessCommand = createWorkflowAssessCommand();
  sharedCommandRegistry.registerCommand({
    id: assessCommand.id,
    category: CommandCategory.WORKFLOW,
    name: assessCommand.name,
    description: assessCommand.description,
    parameters: assessCommand.parameters,
    execute: async (params: any, ctx: any) => {
      return await assessCommand.execute(params, ctx);
    },
  });

  // Register workflow init command
  const initCommand = createWorkflowInitCommand();
  sharedCommandRegistry.registerCommand({
    id: initCommand.id,
    category: CommandCategory.WORKFLOW,
    name: initCommand.name,
    description: initCommand.description,
    parameters: initCommand.parameters,
    execute: async (params: any, ctx: any) => {
      return await initCommand.execute(params, ctx);
    },
  });

  // Register workflow add command
  const addCommand = createWorkflowAddCommand();
  sharedCommandRegistry.registerCommand({
    id: addCommand.id,
    category: CommandCategory.WORKFLOW,
    name: addCommand.name,
    description: addCommand.description,
    parameters: addCommand.parameters,
    execute: async (params: any, ctx: any) => {
      return await addCommand.execute(params, ctx);
    },
  });

  // Register workflow run command
  const runCommand = createWorkflowRunCommand();
  sharedCommandRegistry.registerCommand({
    id: runCommand.id,
    category: CommandCategory.WORKFLOW,
    name: runCommand.name,
    description: runCommand.description,
    parameters: runCommand.parameters,
    execute: async (params: any, ctx: any) => {
      return await runCommand.execute(params, ctx);
    },
  });

  // Register workflow list command
  const listCommand = createWorkflowListCommand();
  sharedCommandRegistry.registerCommand({
    id: listCommand.id,
    category: CommandCategory.WORKFLOW,
    name: listCommand.name,
    description: listCommand.description,
    parameters: listCommand.parameters,
    execute: async (params: any, ctx: any) => {
      return await listCommand.execute(params, ctx);
    },
  });
}
