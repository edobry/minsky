/**
 * CLI Bridge
 *
 * This module bridges the shared command registry with the Commander.js CLI,
 * enabling automatic generation of CLI commands from shared command definitions.
 */
import { Command } from "commander";
import { CommandCategory } from "../command-registry";

import {
  CliCommandGenerator,
  cliCommandGenerator,
  type CliCommandOptions,
  type CategoryCommandOptions,
} from "./cli-command-generator";

/**
 * Main CLI bridge class
 *
 * Handles conversion of shared commands to Commander.js commands
 *
 * ⚠️  WARNING: This class should not be used directly in most cases.
 * Use the CLI Command Factory instead to ensure proper customizations are applied.
 *
 * @internal - This class is intended to be used through the CLI Command Factory
 */
export class CliCommandBridge {
  private generator: CliCommandGenerator;

  constructor() {
    this.generator = new CliCommandGenerator();
  }

  /**
   * Register command customization options
   */
  registerCommandCustomization(commandId: string, options: CliCommandOptions): void {
    this.generator.registerCommandCustomization(commandId, options);
  }

  /**
   * Register category customization options
   */
  registerCategoryCustomization(category: CommandCategory, options: CategoryCommandOptions): void {
    this.generator.registerCategoryCustomization(category, options);
  }

  /**
   * Generate a CLI command from a shared command definition
   *
   * ⚠️  WARNING: Use CLI Command Factory instead for proper customization support
   * @internal
   */
  generateCommand(commandId: string, context?: { viaFactory?: boolean }): Command | null {
    return this.generator.generateCommand(commandId, context);
  }

  /**
   * Generate CLI commands for all commands in a category
   *
   * ⚠️  WARNING: Use CLI Command Factory instead for proper customization support
   * @internal
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    return this.generator.generateCategoryCommand(category, context);
  }

  /**
   * Generate CLI commands for all categories
   *
   * ⚠️  WARNING: Use CLI Command Factory instead for proper customization support
   * @internal
   */
  generateAllCategoryCommands(program: Command, context?: { viaFactory?: boolean }): void {
    this.generator.generateAllCategoryCommands(program, context);
  }



  /**
   * Format session details for human-readable output
   */
  private formatSessionDetails(session: Record<string, any>): void {
    if (!session) return;

    // Display session information in a user-friendly format
    if ((session as any).session) log.cli(`Session: ${(session as any).session}`);
    if ((session as any).taskId) log.cli(`Task ID: ${(session as any).taskId}`);
    if ((session as any).repoName) log.cli(`Repository: ${(session as any).repoName}`);
    if ((session as any).repoPath) log.cli(`Session Path: ${(session as any).repoPath}`);
    if ((session as any)._branch) log.cli(`Branch: ${(session as any)._branch}`);
    if ((session as any).createdAt) log.cli(`Created: ${(session as any).createdAt}`);
    if ((session as any).backendType) log.cli(`Backend: ${(session as any).backendType}`);
    if ((session as any).repoUrl && (session as any).repoUrl !== (session as any).repoName) {
      log.cli(`Repository URL: ${(session as any).repoUrl}`);
    }
  }

  /**
   * Format session start success message for human-readable output
   */
  private formatSessionStartSuccess(session: Record<string, any>): void {
    if (!session) return;

    // Display a user-friendly success message for session creation
    log.cli("✅ Session started successfully!");
    log.cli("");

    if ((session as any).session) {
      log.cli(`📁 Session: ${(session as any).session}`);
    }

    if ((session as any).taskId) {
      log.cli(`🎯 Task: ${(session as any).taskId}`);
    }

    if ((session as any).repoName) {
      log.cli(`📦 Repository: ${(session as any).repoName}`);
    }

    if ((session as any).branch) {
      log.cli(`🌿 Branch: ${(session as any).branch}`);
    }

    log.cli("");
    log.cli("🚀 Ready to start development!");
    log.cli("");
    log.cli("💡 Next steps:");
    log.cli("   • Your session workspace is ready for editing");
    log.cli("   • All changes will be tracked on your session branch");
    log.cli("   • Run \"minsky session pr\" when ready to create a pull request");
  }

  /**
   * Format session summary for list views
   */
  private formatSessionSummary(session: Record<string, any>): void {
    if (!session) return;

    const sessionName = (session as any).session || "unknown";
    const taskId = (session as any).taskId ? ` (${(session as any).taskId})` : "";
    const repoName = (session as any).repoName ? ` - ${(session as any).repoName}` : "";

    log.cli(`${sessionName}${taskId}${repoName}`);
  }

  /**
   * Format session pr details for human-readable output
   */
  private formatSessionPrDetails(result: Record<string, any>): void {
    if (!result) return;

    const prBranch = (result as any).prBranch || "unknown";
    const baseBranch = (result as any).baseBranch || "main";
    const title = (result as any).title || "Untitled PR";
    const body = (result as any).body || "";

    // Header
    log.cli("✅ PR branch created successfully!");
    log.cli("");

    // PR Details Section
    log.cli("📝 PR Details:");
    log.cli(`   Title: ${title}`);
    log.cli(`   PR Branch: ${prBranch}`);
    log.cli(`   Base Branch: ${baseBranch}`);

    if (body && typeof body === "string" && (body as any).trim()) {
      const truncatedBody =
        (body as any).length > 100 ? `${(body as any).substring(0, 100)}...` : body;
      log.cli(`   Body: ${truncatedBody}`);
    }
    log.cli("");

    // Next Steps Section
    log.cli("🚀 Next Steps:");
    log.cli("   1. Review the PR branch in your repository");
    log.cli("   2. Create a pull request in your Git hosting platform (GitHub, GitLab, etc.)");
    log.cli("   3. Request reviews from team members");
    log.cli("   4. Merge the PR when approved");
    log.cli("");

    // Commands Section
    log.cli("📋 Useful Commands:");
    log.cli(`   • View PR branch: git checkout ${prBranch}`);
    log.cli("   • Approve and merge: minsky session approve");
    log.cli(`   • Switch back to main: git checkout ${baseBranch}`);
    log.cli("");

    // Status message
    if ((result as any).taskUpdated) {
      log.cli("✅ Task status updated to IN-REVIEW");
    }
  }

  /**
   * Format session approval details for human-readable output
   */
  private formatSessionApprovalDetails(result: Record<string, any>): void {
    if (!result) return;

    const sessionName = (result as any).session || "unknown";
    const taskId = (result as any).taskId || "";
    const commitHash = (result as any).commitHash || "";
    const mergeDate = (result as any).mergeDate || "";
    const mergedBy = (result as any).mergedBy || "";
    const baseBranch = (result as any).baseBranch || "main";
    const prBranch = (result as any).prBranch || "";
    const isNewlyApproved = (result as any).isNewlyApproved !== false; // default to true for backward compatibility

    // Header - different based on whether newly approved or already approved
    if (isNewlyApproved) {
      log.cli("✅ Session approved and merged successfully!");
    } else {
      log.cli("ℹ️  Session was already approved and merged");
    }
    log.cli("");

    // Session Details
    log.cli("📝 Session Details:");
    log.cli(`   Session: ${sessionName}`);
    if (taskId) {
      const taskStatusMessage = isNewlyApproved ? "(status updated to DONE)" : "(already marked as DONE)";
      log.cli(`   Task: ${taskId} ${taskStatusMessage}`);
    }
    log.cli(`   Merged by: ${mergedBy}`);
    if (mergeDate) {
      const date = new Date(mergeDate);
      log.cli(`   Merge date: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
    }
    log.cli("");

    // Technical Details
    log.cli("🔧 Technical Details:");
    log.cli(`   Base branch: ${baseBranch}`);
    if (prBranch) {
      log.cli(`   PR branch: ${prBranch}`);
    }
    if (commitHash) {
      log.cli(`   Commit hash: ${commitHash.substring(0, 8)}`);
    }
    log.cli("");

    // Success message - different based on whether newly approved or already approved
    if (isNewlyApproved) {
      log.cli("🎉 Your work has been successfully merged and the session is complete!");
    } else {
      log.cli("✅ Session is already complete - no action needed!");
    }
  }

  /**
   * Format debug echo details for human-readable output
   */
  private formatDebugEchoDetails(result: Record<string, any>): void {
    if (!result) return;

    // Display a user-friendly debug echo response
    log.cli("🔍 Debug Echo Response");
    log.cli("");

    if (result.timestamp) {
      log.cli(`⏰ Timestamp: ${result.timestamp}`);
    }

    if (result.interface) {
      log.cli(`🔗 Interface: ${result.interface}`);
    }

    if (result.echo && typeof result.echo === "object") {
      log.cli("📝 Echo Parameters:");
      const echoParams = result.echo as Record<string, any>;

      if (Object.keys(echoParams).length === 0) {
        log.cli("   (no parameters provided)");
      } else {
        Object.entries(echoParams).forEach(([key, value]) => {
          if (typeof value === "string") {
            log.cli(`   ${key}: "${value}"`);
          } else if (typeof value === "object" && value !== null) {
            log.cli(`   ${key}: ${JSON.stringify(value)}`);
          } else {
            log.cli(`   ${key}: ${value}`);
          }
        });
      }
    }

    log.cli("");
    log.cli("✅ Debug echo completed successfully");
  }

  /**
   * Format rule details for human-readable output
   */
  private formatRuleDetails(rule: Record<string, any>): void {
    if (!rule) return;

    // Display rule information in a user-friendly format
    if ((rule as any).id) log.cli(`Rule: ${(rule as any).id}`);
    if ((rule as any).description) log.cli(`Description: ${(rule as any).description}`);
    if ((rule as any).format) log.cli(`Format: ${(rule as any).format}`);
    if ((rule as any).globs && Array.isArray((rule as any).globs)) {
      log.cli(`Globs: ${(rule.globs as any).join(", ")}`);
    }
    if ((rule as any).tags && Array.isArray((rule as any).tags)) {
      log.cli(`Tags: ${(rule.tags as any).join(", ")}`);
    }
    if ((rule as any).path) log.cli(`Path: ${(rule as any).path}`);
  }

  /**
   * Format rule summary for list views
   */
  private formatRuleSummary(rule: Record<string, any>): void {
    if (!rule) return;

    const ruleId = (rule as any).id || "unknown";
    const description = (rule as any).description ? ` - ${(rule as any).description}` : "";
    const format = (rule as any).format ? ` [${(rule as any).format}]` : "";

    log.cli(`${ruleId}${format}${description}`);
  }
}

/**
 * Default exported instance for the CLI bridge
 * This singleton is used by the CLI to generate commands from the shared registry
 */
export const cliBridge = new CliCommandBridge();

/**
 * Register categorized CLI commands to a Commander.js program
 *
 * @param program The Commander.js program to add commands to
 * @param categories Array of command categories to register
 * @param createSubcommands Whether to create category subcommands
 */
export function registerCategorizedCliCommands(
  program: Command,
  categories: CommandCategory[],
  createSubcommands: boolean = true
): void {
  if (createSubcommands) {
    // Create category-based subcommands
    (categories as any).forEach((category) => {
      const categoryCommand = (cliBridge as any).generateCategoryCommand(category);
      if (categoryCommand) {
        program.addCommand(categoryCommand!);
      }
    });
  } else {
    // Add all commands directly to the program
    (categories as any).forEach((category) => {
      const commands = (sharedCommandRegistry as any).getCommandsByCategory(category);
      commands.forEach((commandDef) => {
        const command = (cliBridge as any).generateCommand((commandDef as any).id);
        if (command) {
          program.addCommand(command);
        }
      });
    });
  }
}
