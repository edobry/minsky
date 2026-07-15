/**
 * Task Command Customizations
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import { log } from "@minsky/shared/logger";

/**
 * Get task command customizations configuration
 * @returns Task category customization options
 */
export function getTasksCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
  [key: string]: unknown;
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
          },
        },
        "tasks.dispatch": {
          // mt#2657: dispatch is dual-mode (title XOR taskId), so `title` is no
          // longer the first REQUIRED param — without this override the bridge
          // would silently promote `instructions` to the positional slot,
          // dropping --instructions from the CLI/manifest surface. Every param
          // stays an explicit flag.
          useFirstRequiredParamAsArgument: false,
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
        // mt#2811 investigated adding a positional `taskId` argument here (mirroring
        // tasks.get/tasks.spec.get) to fix `minsky tasks children <id>` erroring "too many
        // arguments" — but the parameter mapper's `asArgument: true` EXCLUDES a param from the
        // flag-options list entirely (createOptionsFromMappings in parameter-mapper.ts), so
        // promoting `taskId` to positional would have DROPPED the pre-existing, working
        // `--task-id` flag — a breaking CLI-surface change outside this task's scope (PR #1953
        // review 4708851338 R2 BLOCKING). Reverted: `taskId`/`task` remain plain flag-only
        // options here, unchanged from before mt#2811, restoring `--task-id` and keeping
        // `--task`. No positional-argument support for these two commands — the actual bug
        // (the parallel-work guard's own CLI invocation) is fixed independently by
        // `buildTasksChildrenArgv` in `.minsky/hooks/parallel-work-guard.ts`, which calls
        // `--task` explicitly and never relied on positional-argument registration existing.
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
        "tasks.reparent": {
          useFirstRequiredParamAsArgument: true,
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to reparent (e.g. mt#123)",
            },
            parent: {
              asArgument: false,
              description: "New parent task ID (e.g. mt#456), or omit with --no-parent to orphan",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }
            if (result.success) {
              log.cli(result.output || "✅ Task reparented successfully");
            } else {
              log.cli(result.error || "❌ Failed to reparent task");
            }
          },
        },
        "tasks.deps.add": {
          // mt#2741: taskId is the canonical positional; `task` is the legacy --task
          // alias option; dependsOn stays --depends-on. useFirstRequiredParamAsArgument
          // is disabled so the now-only-required `dependsOn` is NOT auto-forced into the
          // positional slot (which dropped --depends-on from the generated CLI/manifest).
          useFirstRequiredParamAsArgument: false,
          parameters: {
            taskId: {
              asArgument: true,
              description: "The dependent task (the task that will depend on another)",
            },
            task: {
              asArgument: false,
              description: "Legacy alias for taskId (also accepted; prefer taskId)",
            },
            dependsOn: {
              asArgument: false,
              description: "Task that is the dependency",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
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
          // mt#2741: see tasks.deps.add — canonical taskId positional, task alias option,
          // dependsOn stays --depends-on, auto-first-required-arg disabled.
          useFirstRequiredParamAsArgument: false,
          parameters: {
            taskId: {
              asArgument: true,
              description: "The dependent task (the task that depends on another)",
            },
            task: {
              asArgument: false,
              description: "Legacy alias for taskId (also accepted; prefer taskId)",
            },
            dependsOn: {
              asArgument: false,
              description: "Task that is the dependency",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
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
          // mt#2741: canonical taskId positional + legacy --task alias option.
          useFirstRequiredParamAsArgument: false,
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to list dependencies for",
            },
            task: {
              asArgument: false,
              description: "Legacy alias for taskId (also accepted; prefer taskId)",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
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
          // mt#2741: canonical taskId positional + legacy --task alias option.
          useFirstRequiredParamAsArgument: false,
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to show dependency tree for",
            },
            task: {
              asArgument: false,
              description: "Legacy alias for taskId (also accepted; prefer taskId)",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
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
            format: {
              description:
                "Output format: ascii (terminal), dot (Graphviz), svg/png/pdf (rendered)",
            },
            output: {
              description:
                "Output file path (auto-generated if not specified for rendered formats)",
            },
            layout: {
              description: "Layout engine (dot, neato, fdp, circo, twopi)",
            },
            direction: {
              description: "Direction (TB, BT) - vertical layouts only",
            },
            spacing: {
              description: "Spacing (compact, normal, wide)",
            },
            style: {
              description: "Visual style (default, tech-tree, kanban, mobile, compact)",
            },
            open: {
              description: "Automatically open the rendered file in the default application",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
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
    available: {
      parameters: {
        status: {
          description: "Filter by task status (default: TODO,IN-PROGRESS)",
        },
        backend: {
          description: "Filter by specific backend (mt, md, gh, etc.)",
        },
        limit: {
          description: "Maximum number of tasks to show",
        },
        showEffort: {
          description: "Include effort estimates if available",
        },
        showPriority: {
          description: "Include priority information if available",
        },
        json: {
          description: "Output in JSON format",
        },
        minReadiness: {
          description: "Minimum readiness score (0.0-1.0) to include task",
        },
      },
      outputFormatter: (result: Record<string, unknown>) => {
        if (result.json) {
          log.cli(JSON.stringify(result, null, 2));
          return;
        }
        if (result.output) {
          log.cli(result.output);
        } else if (result.error) {
          log.cli(result.error);
        } else {
          log.cli("❌ No available tasks found");
        }
      },
    },
    route: {
      parameters: {
        target: {
          asArgument: true,
          description: "Target task ID to generate route for",
        },
        strategy: {
          description: "Routing strategy (ready-first, shortest-path, value-first)",
        },
        parallel: {
          description: "Show parallel execution opportunities",
        },
        json: {
          description: "Output in JSON format",
        },
      },
      outputFormatter: (result: Record<string, unknown>) => {
        if (result.json) {
          log.cli(JSON.stringify(result, null, 2));
          return;
        }
        if (result.output) {
          log.cli(result.output);
        } else if (result.error) {
          log.cli(result.error);
        } else {
          log.cli("❌ No route available");
        }
      },
    },
  };
}
