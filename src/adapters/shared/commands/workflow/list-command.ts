/**
 * Workflow List Command
 *
 * Command for listing configured workflows and showing status/recommendations.
 */

import { CommandExecutionContext } from "../../command-registry";
import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandParameterMap } from "../../schema-bridge";
import { WorkflowService } from "../../../../domain/workflow";
import { log } from "../../../../utils/logger";

export interface WorkflowListParams {
  builtin?: boolean;
  status?: boolean;
  debug?: boolean;
}

export const workflowListParams: CommandParameterMap = composeParams(
  {
    builtin: {
      schema: z.boolean(),
      description: "Show available built-in tools instead of configured workflows",
      required: false,
      defaultValue: false,
    },
    status: {
      schema: z.boolean(),
      description: "Show workflow status and recommendations",
      required: false,
      defaultValue: false,
    },
  },
  {
    debug: CommonParameters.debug,
  }
);

/**
 * Workflow List Command Implementation
 */
export class WorkflowListCommand {
  readonly id = "workflow.list";
  readonly name = "list";
  readonly description = "List configured workflows or available built-in tools";
  readonly parameters = workflowListParams;

  async execute(params: WorkflowListParams, ctx?: CommandExecutionContext) {
    try {
      // Get current workspace directory
      const workspaceDir = process.cwd();
      const service = new WorkflowService(workspaceDir);

      let result: string;

      if (params.builtin) {
        // Show available built-in tools
        result = await service.listBuiltinTools();
      } else if (params.status) {
        // Show status with recommendations
        result = await service.getStatus();
      } else {
        // Show configured workflows
        const workflows = await service.getConfiguredWorkflows();
        const { formatWorkflowSummary } = await import(
          "../../../../domain/workflow/output-formatters"
        );
        result = formatWorkflowSummary(workflows);
      }

      return {
        success: true,
        result,
      };
    } catch (error) {
      if (params.debug) {
        log.debug("Workflow list error:", error);
      }

      throw error;
    }
  }
}

/**
 * Create workflow list command instance
 */
export function createWorkflowListCommand(): WorkflowListCommand {
  return new WorkflowListCommand();
}
