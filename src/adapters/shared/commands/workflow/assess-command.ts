/**
 * Workflow Assess Command
 *
 * Command for performing development workflow maturity assessment.
 * Evaluates projects across 7 categories and provides recommendations.
 */

import { CommandExecutionContext } from "../../command-registry";
import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandParameterMap } from "../../schema-bridge";
import { WorkflowService } from "../../../../domain/workflow";
import { log } from "../../../../utils/logger";

export interface WorkflowAssessParams {
  format?: "json" | "text" | "summary";
  debug?: boolean;
}

export const workflowAssessParams: CommandParameterMap = composeParams(
  {
    format: {
      schema: z.enum(["json", "text", "summary"]),
      description: "Output format",
      required: false,
      defaultValue: "text",
    },
  },
  {
    debug: CommonParameters.debug,
  }
);

/**
 * Workflow Assess Command Implementation
 */
export class WorkflowAssessCommand {
  readonly id = "workflow.assess";
  readonly name = "assess";
  readonly description = "Assess development workflow maturity";
  readonly parameters = workflowAssessParams;

  async execute(params: WorkflowAssessParams, ctx?: CommandExecutionContext) {
    try {
      // Get current workspace directory
      const workspaceDir = process.cwd();
      const service = new WorkflowService(workspaceDir);

      // Perform assessment
      const result = await service.assess(params.format);

      return {
        success: true,
        result,
        format: params.format || "text",
      };
    } catch (error) {
      if (params.debug) {
        log.debug("Workflow assess error:", error);
      }

      throw error;
    }
  }
}

/**
 * Create workflow assess command instance
 */
export function createWorkflowAssessCommand(): WorkflowAssessCommand {
  return new WorkflowAssessCommand();
}
