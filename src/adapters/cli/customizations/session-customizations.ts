/**
 * Session Command Customizations
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import { log } from "../../../utils/logger";
import { getMinskyStateDir } from "../../../utils/paths";

/**
 * Get session command customizations configuration
 * @returns Session category customization options
 */
export function getSessionCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
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
            sessionId: {
              asArgument: true,
              description: "Session ID (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description:
                "Task ID to associate with the session (required if --description not provided)",
            },
            description: {
              alias: "d",
              description: "Description for auto-created task (required if --task not provided)",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
            // Check if JSON output was requested
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }

            // Check if quiet mode was requested
            if (result.quiet) {
              // In quiet mode, only output session directory path
              if (result.session) {
                const session = result.session as Record<string, unknown>;
                const sessionDir = `${getMinskyStateDir()}/sessions/${session.session}`;
                log.cli(sessionDir);
              }
              return;
            }

            // Format the session start success message
            if (result.success && result.session) {
              const session = result.session as Record<string, unknown>;
              // Display a user-friendly success message for session creation
              log.cli("✅ Session started successfully!");
              log.cli("");

              if (session.taskId) {
                log.cli(`🎯 Task: ${session.taskId}`);
              }

              if (session.branch) {
                log.cli(`🌿 Branch: ${session.branch}`);
              }

              if (session.session) {
                log.cli(`📁 Session ID: ${session.session}`);
              }

              if (session.repoName) {
                log.cli(`📦 Repository: ${session.repoName}`);
              }

              log.cli("");
              log.cli("🚀 Ready to start development!");
              log.cli("");
              log.cli("💡 Next steps:");
              log.cli("   • Your session workspace is ready for editing");
              log.cli("   • All changes will be tracked on your session branch");
              log.cli('   • Run "minsky session pr" when ready to create a pull request');
            } else {
              // Fallback to JSON output if result structure is unexpected
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },
        "session.get": {
          parameters: {
            sessionId: {
              asArgument: true,
              description: "Session ID (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.dir": {
          parameters: {
            sessionId: {
              asArgument: true,
              description: "Session ID",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.delete": {
          parameters: {
            sessionId: {
              asArgument: true,
              description: "Session ID",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.update": {
          parameters: {
            sessionId: {
              asArgument: true,
              description: "Session ID",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
        },
        "session.approve": {
          parameters: {
            sessionId: {
              asArgument: true,
              description: "Session ID",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
            // Check if JSON output was requested
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }

            // Format the session approval result
            if (result.success) {
              const data = result.data as Record<string, unknown> | undefined;

              if (data && data.isNewlyApproved) {
                log.cli("✅ Session approved and merged successfully!");
              } else if (data) {
                log.cli("ℹ️  Session was already approved and merged");
              } else {
                log.cli("⚠️  Session approval completed but result structure unexpected");
                log.cli(JSON.stringify(result, null, 2));
                return;
              }

              if (data) {
                log.cli("");
                log.cli("📝 Session Details:");
                if (data.taskId) {
                  log.cli(`   Task: ${data.taskId} (status updated to DONE)`);
                }
                if (data.prBranch) {
                  log.cli(`   Branch: ${data.prBranch}`);
                }
                log.cli(`   Session ID: ${data.session}`);
                log.cli(`   Merged by: ${data.mergedBy}`);
                log.cli(`   Merge date: ${new Date(data.mergeDate as string).toLocaleString()}`);

                log.cli("");
                log.cli("🔧 Technical Details:");
                log.cli(`   Base branch: ${data.baseBranch}`);
                log.cli(`   PR branch: ${data.prBranch}`);
                log.cli(`   Commit hash: ${(data.commitHash as string).substring(0, 8)}`);

                log.cli("");
                if (data.isNewlyApproved) {
                  log.cli("🎉 Your work has been successfully merged and the session is complete!");
                } else {
                  log.cli("✅ Session is already complete - no action needed!");
                }
              }
            } else {
              // Fallback to JSON output if result structure is unexpected
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },
        // Replaced session.pr with subcommands
        "session.pr.create": {
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
            sessionId: {
              description: "Session ID (auto-detected from workspace if not provided)",
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
            draft: {
              description: "Create draft PR (GitHub only, skips session update)",
            },
          },
        },
        // New PR subcommands
        "session.pr.list": {
          useFirstRequiredParamAsArgument: false,
          parameters: {
            session: {
              description: "Filter PRs by specific session ID",
            },
            task: {
              alias: "t",
              description: "Task ID",
            },
            status: {
              description:
                "Filter by PR status. Valid options: open, closed, merged, draft, created, unknown, not_found, all (or comma-separated combinations)",
            },
            repo: {
              description: "Repository path",
            },
            json: {
              description: "Output in JSON format",
            },
            verbose: {
              description: "Show detailed PR information",
            },
          },
        },
        "session.pr.get": {
          useFirstRequiredParamAsArgument: false,
          parameters: {
            sessionId: {
              description: "Session ID to look up PR for (positional)",
            },
            task: {
              alias: "t",
              description: "Task ID",
            },
            repo: {
              description: "Repository path",
            },
            json: {
              description: "Output in JSON format",
            },
            content: {
              description: "Include PR description and diff content",
            },
          },
        },
        "session.edit-file": {
          useFirstRequiredParamAsArgument: false,
          parameters: {
            session: {
              alias: "s",
              description: "Session ID (auto-detected from workspace if not provided)",
            },
            path: {
              description: "Path to the file within the session workspace",
            },
            instruction: {
              alias: "i",
              description: "Instructions describing the edit to make",
            },
            patternFile: {
              alias: "f",
              description: "Path to file containing edit pattern (alternative to stdin)",
            },
            dryRun: {
              alias: "n",
              description: "Preview changes without writing to disk",
            },
            createDirs: {
              description: "Create parent directories if they don't exist",
            },
            json: {
              description: "Output in JSON format",
            },
            debug: {
              description: "Enable debug output",
            },
          },
          outputFormatter: (result) => {
            if (result.json) {
              return JSON.stringify(result, null, 2);
            }

            if (result.type === "dry-run") {
              return result.message;
            } else if (result.type === "edit-applied") {
              return result.message;
            }

            return "Edit completed successfully";
          },
        },
      },
    },
  };
}
