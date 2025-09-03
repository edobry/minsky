/**
 * Workflow Init Command
 *
 * Command for initializing workflow configuration based on project detection.
 * Detects project type and suggests appropriate workflow tools.
 */

import { CommandExecutionContext } from "../../command-registry";
import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandParameterMap } from "../../schema-bridge";
import { WorkflowService } from "../../../../domain/workflow";
import { log } from "../../../../utils/logger";

export interface WorkflowInitParams {
  interactive?: boolean;
  force?: boolean;
  debug?: boolean;
}

export const workflowInitParams: CommandParameterMap = composeParams(
  {
    interactive: {
      schema: z.boolean(),
      description: "Use interactive mode for workflow selection",
      required: false,
      defaultValue: false,
    },
    force: {
      schema: z.boolean(),
      description: "Force reinitialize even if workflows already exist",
      required: false,
      defaultValue: false,
    },
  },
  {
    debug: CommonParameters.debug,
  }
);

/**
 * Workflow Init Command Implementation
 */
export class WorkflowInitCommand {
  readonly id = "workflow.init";
  readonly name = "init";
  readonly description = "Initialize workflow configuration with project detection";
  readonly parameters = workflowInitParams;

  async execute(params: WorkflowInitParams, ctx?: CommandExecutionContext) {
    try {
      // Get current workspace directory
      const workspaceDir = process.cwd();
      const service = new WorkflowService(workspaceDir);

      // Initialize workflows
      const result = await service.init({
        interactive: params.interactive,
        force: params.force,
      });

      return {
        success: true,
        result,
      };
    } catch (error) {
      if (params.debug) {
        log.debug("Workflow init error:", error);
      }

      throw error;
    }
  }
}

/**
 * Create workflow init command instance
 */
export function createWorkflowInitCommand(): WorkflowInitCommand {
  return new WorkflowInitCommand();
}
