/**
 * CLI Result Formatters
 *
 * Formatting utilities for CLI command results.
 * Extracted from CliCommandBridge to improve modularity.
 *
 * TASK 283: Updated to use formatTaskIdForDisplay() for consistent # prefix display.
 */
import { log } from "../../../utils/logger";
import { formatTaskIdForDisplay } from "../../../domain/tasks/task-id-utils";

/**
 * Returns a colored liveness indicator dot for terminal output.
 * Respects NO_COLOR env var and non-TTY stdout (e.g. pipes).
 */
function formatLivenessIndicator(status?: string, liveness?: string): string {
  const noColor = process.env.NO_COLOR || !process.stdout.isTTY;
  const colorize = (code: string, text: string) => (noColor ? text : `\x1b[${code}m${text}\x1b[0m`);

  if (status === "MERGED" || status === "CLOSED") return colorize("90", "●"); // gray
  if (liveness === "healthy") return colorize("32", "●"); // green
  if (liveness === "idle") return colorize("33", "●"); // yellow
  if (liveness === "stale" || liveness === "orphaned") return colorize("31", "●"); // red
  return colorize("90", "○"); // gray hollow
}

/**
 * Format session details for human-readable output
 */
export function formatSessionDetails(session: Record<string, unknown>): void {
  if (!session) return;

  // Display session information in a user-friendly format
  log.cli("📄 Session Details:");
  log.cli("");

  if (session.taskId) log.cli(`   Task: ${formatTaskIdForDisplay(session.taskId as string)}`);
  if (session.branchName) log.cli(`   Branch: ${session.branchName}`);
  if (session.session) log.cli(`   Session ID: ${session.session}`);
  if (session.id) log.cli(`   ID: ${session.id}`);
  if (session.name) log.cli(`   Name: ${session.name}`);
  if (session.status) log.cli(`   Status: ${session.status}`);
  if (session.liveness) log.cli(`   Liveness: ${session.liveness}`);
  if (session.lastActivityAt) {
    const date = new Date(session.lastActivityAt as string);
    log.cli(`   Last activity: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
  }
  if (session.commitCount !== undefined) log.cli(`   Commits: ${session.commitCount}`);
  if (session.lastCommitHash) {
    log.cli(
      `   Last commit: ${(session.lastCommitHash as string).substring(0, 8)} — ${session.lastCommitMessage || ""}`
    );
  }
  if (session.workspacePath) log.cli(`   Workspace: ${session.workspacePath}`);
  if (session.repoUrl) log.cli(`   Repository: ${session.repoUrl}`);
  if (session.createdAt) {
    const date = new Date(session.createdAt as string);
    log.cli(`   Created: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
  }
  if (session.lastUpdated) {
    const date = new Date(session.lastUpdated as string);
    log.cli(`   Updated: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
  }

  // PR information
  if (session.prBranch) {
    log.cli(`   PR Branch: ${session.prBranch}`);
    if (session.prApproved) {
      log.cli(`   PR Status: ✅ Approved`);
    } else {
      log.cli(`   PR Status: ⏳ Pending approval`);
    }
  }

  log.cli("");
}

/**
 * Format session summary for list views
 */
export function formatSessionSummary(session: Record<string, unknown>): void {
  if (!session) return;

  const status = session.status as string | undefined;
  const liveness = session.liveness as string | undefined;
  const indicator = formatLivenessIndicator(status, liveness);

  // TASK 643: Lead with task ID and branch; UUID is secondary debug info
  if (session.taskId) {
    const taskDisplay = formatTaskIdForDisplay(session.taskId as string);
    const branchName = session.branch ? ` (${session.branch})` : "";
    const uuid = session.session ? ` [${(session.session as string).substring(0, 8)}...]` : "";
    log.cli(`${indicator} ${taskDisplay}${branchName}${uuid}`);
  } else {
    // Taskless session: just show UUID
    const sessionId = session.session || "unknown";
    const branchName = session.branch ? ` [${session.branch}]` : "";
    log.cli(`${indicator} ${sessionId}${branchName}`);
  }
}

/**
 * Format a list of sessions in verbose (full-details) mode
 */
export function formatSessionListVerbose(sessions: unknown[]): void {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    log.cli("No sessions found.");
    return;
  }
  sessions.forEach((session) => {
    formatSessionDetails(session as Record<string, unknown>);
  });
}

/**
 * Format session PR details for human-readable output
 */
export function formatSessionPrDetails(result: Record<string, unknown>): void {
  if (!result) return;

  const sessionObj = result.session as Record<string, unknown> | undefined;
  const sessionId = sessionObj?.session || result.sessionId || "Unknown";
  const taskId = sessionObj?.taskId || result.taskId || "";
  const prBranch = result.prBranch || "";
  const prUrl = result.prUrl || "";
  const baseBranch = result.baseBranch || "main";
  const commitHash = result.commitHash || "";
  const prStatus = result.prStatus || "created";

  // Header
  log.cli("📋 Session PR Details:");
  log.cli("");

  // Session Information
  log.cli("📝 Session Information:");
  if (taskId) {
    log.cli(`   Task: ${formatTaskIdForDisplay(taskId as string)}`);
  }
  if (prBranch) {
    log.cli(`   Branch: ${prBranch}`);
  }
  log.cli(`   Session ID: ${sessionId}`);
  log.cli("");

  // PR Information
  log.cli("🔗 Pull Request Information:");
  log.cli(`   Status: ${prStatus}`);
  log.cli(`   Base: ${baseBranch}`);
  if (commitHash) {
    log.cli(`   Commit: ${(commitHash as string).substring(0, 8)}`);
  }
  if (prUrl) {
    log.cli(`   URL: ${prUrl}`);
  }
  log.cli("");

  // Success message
  log.cli("✅ Pull request ready for review!");
}

/**
 * Format session approval details for human-readable output
 */
export function formatSessionApprovalDetails(result: Record<string, unknown>): void {
  if (!result) return;

  const sessionObj2 = result.session as Record<string, unknown> | undefined;
  const sessionId = sessionObj2?.session || result.sessionId || "Unknown";
  const taskId = sessionObj2?.taskId || result.taskId || "";
  const commitHash = result.commitHash || "";
  const mergeDate = result.mergeDate || "";
  const mergedBy = result.mergedBy || "";
  const baseBranch = result.baseBranch || "main";
  const prBranch = result.prBranch || "";
  const isNewlyApproved = result.isNewlyApproved !== false; // default to true for backward compatibility

  // Header - different based on whether newly approved or already approved
  if (isNewlyApproved) {
    log.cli("✅ Session approved and merged successfully!");
  } else {
    log.cli("ℹ️  Session was already approved and merged");
  }
  log.cli("");

  // Session Details
  log.cli("📝 Session Details:");
  if (taskId) {
    const taskStatusMessage = isNewlyApproved
      ? "(status updated to DONE)"
      : "(already marked as DONE)";
    log.cli(`   Task: ${formatTaskIdForDisplay(taskId as string)} ${taskStatusMessage}`);
  }
  if (prBranch) {
    log.cli(`   Branch: ${prBranch}`);
  }
  log.cli(`   Session ID: ${sessionId}`);
  log.cli(`   Merged by: ${mergedBy}`);
  if (mergeDate) {
    const date = new Date(mergeDate as string);
    log.cli(`   Merge date: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
  }
  log.cli("");

  // Technical Details
  log.cli("🔧 Technical Details:");
  log.cli(`   Base branch: ${baseBranch}`);
  if (commitHash) {
    log.cli(`   Commit hash: ${(commitHash as string).substring(0, 8)}`);
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
export function formatDebugEchoDetails(result: Record<string, unknown>): void {
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
    const echoParams = result.echo as Record<string, unknown>;

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
export function formatRuleDetails(rule: Record<string, unknown>): void {
  if (!rule) return;

  // Display rule information in a user-friendly format
  if (rule.id) log.cli(`Rule: ${rule.id}`);
  if (rule.description) log.cli(`Description: ${rule.description}`);
  if (rule.format) log.cli(`Format: ${rule.format}`);
  if (rule.globs && Array.isArray(rule.globs)) {
    log.cli(`Globs: ${rule.globs.join(", ")}`);
  }
  if (rule.tags && Array.isArray(rule.tags)) {
    log.cli(`Tags: ${rule.tags.join(", ")}`);
  }
  if (rule.path) log.cli(`Path: ${rule.path}`);
}

/**
 * Format rule summary for list views
 */
export function formatRuleSummary(rule: Record<string, unknown>): void {
  if (!rule) return;

  const ruleId = rule.id || "unknown";
  const description = rule.description ? ` - ${rule.description}` : "";
  const format = rule.format ? ` [${rule.format}]` : "";

  log.cli(`${ruleId}${format}${description}`);
}
