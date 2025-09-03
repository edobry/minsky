/**
 * Workflow Add Command
 *
 * Command for adding specific workflow tools to the configuration.
 * Supports both built-in tool profiles and custom commands.
 */

import { CommandExecutionContext } from "../../command-registry";
import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandParameterMap } from "../../schema-bridge";
import { WorkflowService } from "../../../../domain/workflow";
import { log } from "../../../../utils/logger";

export interface WorkflowAddParams {
  name: string;
  tool: string;
  args?: string;
  custom?: boolean;
  debug?: boolean;
}

export const workflowAddParams: CommandParameterMap = composeParams(
  {
    name: {
      schema: z.string().min(1),
      description: "Workflow name (e.g. 'lint', 'test', 'format')",
      required: true,
    },
    tool: {
      schema: z.string().min(1),
      description: "Tool name (e.g. 'eslint', 'jest') or custom command",
      required: true,
    },
    args: {
      schema: z.string(),
      description: "Additional arguments for built-in tools",
      required: false,
    },
    custom: {
      schema: z.boolean(),
      description: "Treat as custom command rather than built-in tool",
      required: false,
      defaultValue: false,
    },
  },
  {
    debug: CommonParameters.debug,
  }
);

/**
 * Workflow Add Command Implementation
 */
export class WorkflowAddCommand {
  readonly id = "workflow.add";
  readonly name = "add";
  readonly description = "Add a workflow tool to the configuration";
  readonly parameters = workflowAddParams;

  async execute(params: WorkflowAddParams, ctx?: CommandExecutionContext) {
    try {
      // Get current workspace directory
      const workspaceDir = process.cwd();
      const service = new WorkflowService(workspaceDir);

      let workflowConfig: any;

      if (params.custom) {
        // Custom command configuration
        workflowConfig = {
          custom: {
            run: params.tool,
          },
        };
      } else if (params.args) {
        // Built-in tool with arguments
        workflowConfig = {
          tool: params.tool,
          args: params.args,
        };
      } else {
        // Simple built-in tool
        workflowConfig = params.tool;
      }

      // Add workflow
      const result = await service.addWorkflow(params.name, workflowConfig);

      return {
        success: true,
        result,
      };
    } catch (error) {
      if (params.debug) {
        log.debug("Workflow add error:", error);
      }

      throw error;
    }
  }
}

/**
 * Create workflow add command instance
 */
export function createWorkflowAddCommand(): WorkflowAddCommand {
  return new WorkflowAddCommand();
}
