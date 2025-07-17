/**
 * Session Command Customizations
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import { log } from "../../../utils/logger";

/**
 * Get session command customizations configuration
 * @returns Session category customization options
 */
export function getSessionCustomizations(): { category: CommandCategory; options: CategoryCommandOptions } {
  return {
    category: CommandCategory.SESSION,
    options: {
      aliases: ["sess"],
      commandOptions: {
        "session.list": {
          aliases: ["ls"],
          useFirstRequiredParamAsArgument: false,
          parameters: {
            verbose: {
              alias: "v",
              description: "Show detailed session information",
            },
          },
        },
        "session.start": {
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID to associate with the session (required if --description not provided)",
            },
            description: {
              alias: "d",
              description: "Description for auto-created task (required if --task not provided)",
            },
          },
          outputFormatter: (result: any) => {
            // Check if JSON output was requested
            if ((result as any).json) {
              log.cli(JSON.stringify(result as any, null, 2));
              return;
            }

            // Check if quiet mode was requested
            if ((result as any).quiet) {
              // In quiet mode, only output session directory path
              if ((result as any).session) {
                const sessionDir = `/path/to/sessions/${(result as any).session.session}`;
                log.cli(sessionDir);
              }
              return;
            }

            // Format the session start success message
            if ((result as any).success && (result as any).session) {
              // Display a user-friendly success message for session creation
              log.cli("✅ Session started successfully!");
              log.cli("");

              if ((result as any).session.session) {
                log.cli(`📁 Session: ${(result as any).session.session}`);
              }

              if ((result as any).session.taskId) {
                log.cli(`🎯 Task: ${(result as any).session.taskId}`);
              }

              if ((result as any).session.repoName) {
                log.cli(`📦 Repository: ${(result as any).session.repoName}`);
              }

              if ((result as any).session.branch) {
                log.cli(`🌿 Branch: ${(result as any).session.branch}`);
              }

              log.cli("");
              log.cli("🚀 Ready to start development!");
              log.cli("");
              log.cli("💡 Next steps:");
              log.cli("   • Your session workspace is ready for editing");
              log.cli("   • All changes will be tracked on your session branch");
              log.cli("   • Run \"minsky session pr\" when ready to create a pull request");
            } else {
              // Fallback to JSON output if result structure is unexpected
              log.cli(JSON.stringify(result as any, null, 2));
            }
          },
        },
        "session.get": {
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.dir": {
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.delete": {
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.update": {
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.approve": {
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.pr": {
          useFirstRequiredParamAsArgument: false,
          parameters: {
            // === CORE PARAMETERS (Always visible) ===
            title: {
              description: "Title for the PR (auto-generated if not provided)",
            },
            body: {
              description: "Body text for the PR",
            },
            bodyPath: {
              description: "Path to file containing PR body text",
            },
            name: {
              description: "Session name (auto-detected from workspace if not provided)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session (auto-detected if not provided)",
            },

            // === PROGRESSIVE DISCLOSURE CONTROL ===
            advanced: {
              description: "Show advanced options for conflict resolution and debugging",
            },

            // === ADVANCED PARAMETERS (Expert-level control) ===
            skipUpdate: {
              description: "Skip session update before creating PR (use with --advanced)",
            },
            noStatusUpdate: {
              description: "Skip updating task status (use with --advanced)",
            },
            debug: {
              description: "Enable debug output (use with --advanced)",
            },
            autoResolveDeleteConflicts: {
              description: "Auto-resolve delete/modify conflicts (use with --advanced)",
            },
            skipConflictCheck: {
              description: "Skip proactive conflict detection (use with --advanced)",
            },
          },
        },
      },
    },
  };
} 
