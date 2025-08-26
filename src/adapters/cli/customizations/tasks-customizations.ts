/**
 * Task Command Customizations
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";

/**
 * Get task command customizations configuration
 * @returns Task category customization options
 */
export function getTasksCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.TASKS,
    options: {
      aliases: ["task"],
      commandOptions: {
        "tasks.list": {
          useFirstRequiredParamAsArgument: false,
          parameters: {
            filter: {
              alias: "s",
              description: "Filter by task status",
            },
            all: {
              description: "Include completed tasks",
            },
          },
        },
        "tasks.get": {
          parameters: {
            taskId: {
              asArgument: true,
            },
          },
        },
        "tasks.create": {
          useFirstRequiredParamAsArgument: false,
          parameters: {
            title: {
              asArgument: false,
              description: "Title for the task",
            },
            description: {
              description: "Description text for the task",
            },
            specPath: {
              description: "Path to file containing task description",
            },
          },
        },
        "tasks.edit": {
          useFirstRequiredParamAsArgument: true,
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to edit",
            },
            title: {
              description: "New title for the task",
            },
            spec: {
              description: "Edit task specification content interactively",
            },
            specFile: {
              description: "Path to file containing new task specification content",
            },
            specContent: {
              description: "New specification content (completely replaces existing)",
            },
          },
        },
        "tasks.delete": {
          useFirstRequiredParamAsArgument: true,
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to delete",
            },
            force: {
              description: "Force deletion without confirmation",
            },
          },
        },
        "tasks.spec.get": {
          useFirstRequiredParamAsArgument: true,
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to retrieve specification content for",
            },
            section: {
              description: "Specific section of the specification to retrieve",
            },
          },
        },
        "tasks.status.get": {
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to get status for",
            },
          },
        },
        "tasks.status.set": {
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to update",
            },
            status: {
              asArgument: true,
              description: "New status for the task (optional, will prompt if omitted)",
            },
          },
        },
      },
    },
  };
}
