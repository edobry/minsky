/**
 * Task Command Customizations
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import { log } from "../../../utils/logger";

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
        "tasks.deps.add": {
          parameters: {
            task: {
              asArgument: true,
              description: "Task that will depend on another task",
            },
            dependsOn: {
              asArgument: false,
              description: "Task that is the dependency",
            },
          },
          outputFormatter: (result: any) => {
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }
            if (result.success) {
              log.cli(result.output || "✅ Dependency added successfully");
            } else {
              log.cli(result.error || "❌ Failed to add dependency");
            }
          },
        },
        "tasks.deps.rm": {
          parameters: {
            task: {
              asArgument: true,
              description: "Task that depends on another task",
            },
            dependsOn: {
              asArgument: false,
              description: "Task that is the dependency",
            },
          },
          outputFormatter: (result: any) => {
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }
            if (result.success) {
              log.cli(result.output || "✅ Dependency removed successfully");
            } else {
              log.cli(result.error || "❌ Failed to remove dependency");
            }
          },
        },
        "tasks.deps.list": {
          parameters: {
            task: {
              asArgument: true,
              description: "ID of the task to list dependencies for",
            },
          },
          outputFormatter: (result: any) => {
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }
            if (result.success && result.output) {
              log.cli(result.output);
            } else if (result.error) {
              log.cli(result.error);
            } else {
              log.cli("❌ No dependency information available");
            }
          },
        },
        "tasks.deps.tree": {
          parameters: {
            task: {
              asArgument: true,
              description: "ID of the task to show dependency tree for",
            },
          },
          outputFormatter: (result: any) => {
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }
            if (result.success && result.output) {
              log.cli(result.output);
            } else if (result.error) {
              log.cli(result.error);
            } else {
              log.cli("❌ No dependency tree available");
            }
          },
        },
        "tasks.deps.graph": {
          useFirstRequiredParamAsArgument: false,
          parameters: {
            limit: {
              description: "Maximum number of tasks to include",
            },
            status: {
              description: "Filter tasks by status",
            },
          },
          outputFormatter: (result: any) => {
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }
            if (result.success && result.output) {
              log.cli(result.output);
            } else if (result.error) {
              log.cli(result.error);
            } else {
              log.cli("❌ No dependency graph available");
            }
          },
        },
      },
    },
  };
}
