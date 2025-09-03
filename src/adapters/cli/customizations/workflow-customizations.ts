/**
 * Workflow CLI Command Customizations
 *
 * Provides customized CLI output formatting for workflow commands.
 */

import { CommandCategory, type CategoryCommandOptions } from "../core/cli-command-factory-core";
import { log } from "../../../utils/logger";

/**
 * Get workflow command customizations configuration
 */
export function getWorkflowCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.WORKFLOW,
    options: {
      commandOptions: {
        "workflow.assess": {
          parameters: {
            format: {
              description: "Output format (json, text, summary)",
            },
          },
          outputFormatter: (result: any) => {
            if (result.success && result.result) {
              log.cli(result.result);
            } else if (result.error) {
              log.cli(`Error: ${result.error}`);
            } else {
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },

        "workflow.init": {
          parameters: {
            interactive: {
              description: "Use interactive mode for workflow selection",
            },
            force: {
              description: "Force reinitialize even if workflows already exist",
            },
          },
          outputFormatter: (result: any) => {
            if (result.success && result.result) {
              log.cli(result.result);
            } else if (result.error) {
              log.cli(`Error: ${result.error}`);
            } else {
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },

        "workflow.add": {
          useFirstRequiredParamAsArgument: true,
          parameters: {
            name: {
              asArgument: true,
              description: "Workflow name (e.g. 'lint', 'test', 'format')",
            },
            tool: {
              asArgument: true,
              description: "Tool name (e.g. 'eslint', 'jest') or custom command",
            },
            args: {
              description: "Additional arguments for built-in tools",
            },
            custom: {
              description: "Treat as custom command rather than built-in tool",
            },
          },
          outputFormatter: (result: any) => {
            if (result.success && result.result) {
              log.cli(result.result);
            } else if (result.error) {
              log.cli(`Error: ${result.error}`);
            } else {
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },

        "workflow.run": {
          useFirstRequiredParamAsArgument: true,
          parameters: {
            workflow: {
              asArgument: true,
              description: "Workflow name to run (e.g. 'lint', 'test')",
            },
            command: {
              description: "Specific command to run (e.g. 'check', 'fix', 'run')",
            },
          },
          outputFormatter: (result: any) => {
            if (result.success && result.result) {
              log.cli(result.result);
            } else if (result.error) {
              log.cli(`Error: ${result.error}`);
            } else {
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },

        "workflow.list": {
          parameters: {
            builtin: {
              description: "Show available built-in tools instead of configured workflows",
            },
            status: {
              description: "Show workflow status and recommendations",
            },
          },
          outputFormatter: (result: any) => {
            if (result.success && result.result) {
              log.cli(result.result);
            } else if (result.error) {
              log.cli(`Error: ${result.error}`);
            } else {
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },
      },
    },
  };
}
