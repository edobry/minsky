/**
 * Workflow Run Command
 *
 * Command for executing workflow commands directly.
 * Supports running specific semantic commands for configured workflows.
 */

import { CommandExecutionContext } from "../../command-registry";
import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandParameterMap } from "../../schema-bridge";
import { WorkflowService } from "../../../../domain/workflow";
import { log } from "../../../../utils/logger";

export interface WorkflowRunParams {
  workflow: string;
  command?: string;
  debug?: boolean;
}

export const workflowRunParams: CommandParameterMap = composeParams(
  {
    workflow: {
      schema: z.string().min(1),
      description: "Workflow name to run (e.g. 'lint', 'test')",
      required: true,
    },
    command: {
      schema: z.string(),
      description: "Specific command to run (e.g. 'check', 'fix', 'run')",
      required: false,
      defaultValue: "run",
    },
  },
  {
    debug: CommonParameters.debug,
  }
);

/**
 * Workflow Run Command Implementation
 */
export class WorkflowRunCommand {
  readonly id = "workflow.run";
  readonly name = "run";
  readonly description = "Execute a workflow command";
  readonly parameters = workflowRunParams;

  async execute(params: WorkflowRunParams, ctx?: CommandExecutionContext) {
    try {
      // Get current workspace directory
      const workspaceDir = process.cwd();
      const service = new WorkflowService(workspaceDir);

      // Run workflow command
      const result = await service.runWorkflow(params.workflow, params.command);

      return {
        success: true,
        result,
      };
    } catch (error) {
      if (params.debug) {
        log.debug("Workflow run error:", error);
      }

      throw error;
    }
  }
}

/**
 * Create workflow run command instance
 */
export function createWorkflowRunCommand(): WorkflowRunCommand {
  return new WorkflowRunCommand();
}
