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
 * Format session details for human-readable output
 * TASK 360: Enhanced with sync status information for outdated session detection
 */
export function formatSessionDetails(session: Record<string, any>): void {
  if (!session) return;

  // Display session information in a user-friendly format
  log.cli("📄 Session Details:");
  log.cli("");

  if (session.session) log.cli(`   Session: ${session.session}`);
  if (session.taskId) log.cli(`   Task ID: ${formatTaskIdForDisplay(session.taskId)}`);
  if (session.repoName) log.cli(`   Repository: ${session.repoName}`);
  if (session.branch) log.cli(`   Branch: ${session.branch}`);
  if (session.createdAt) {
    const date = new Date(session.createdAt);
    log.cli(`   Created: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
  }

  // TASK 360: Display sync status information if available
  if (session.syncStatus) {
    log.cli("");
    displaySyncStatusSection(session.syncStatus);
  }

  log.cli("");
}

/**
 * Display sync status section for session details
 * TASK 360: New section for outdated session information
 */
function displaySyncStatusSection(syncStatus: any): void {
  if (!syncStatus.isOutdated) {
    log.cli("✅ Session Status: Up to date with main");
    return;
  }

  // Display outdated warning with severity
  const severityIcon = getSeverityIcon(syncStatus.severity);
  const daysSuffix = syncStatus.daysBehind === 1 ? "day" : "days";
  const commitsSuffix = syncStatus.commitsBehind === 1 ? "commit" : "commits";

  log.cli(
    `${severityIcon} OUTDATED: ${syncStatus.commitsBehind} ${commitsSuffix} behind main (${syncStatus.daysBehind} ${daysSuffix} old)`
  );

  if (syncStatus.lastMainCommitDate) {
    const date = new Date(syncStatus.lastMainCommitDate);
    log.cli(
      `   Last main sync: ${syncStatus.lastMainCommit?.substring(0, 8)} (${date.toLocaleDateString()})`
    );
  }

  if (syncStatus.sessionLastUpdate) {
    const date = new Date(syncStatus.sessionLastUpdate);
    log.cli(`   Last updated: ${date.toLocaleDateString()}`);
  }

  log.cli(`   Severity: ${syncStatus.severity?.toUpperCase()}`);

  // Display recent main changes if available
  if (syncStatus.recentChanges && Array.isArray(syncStatus.recentChanges)) {
    log.cli("");
    log.cli("Recent main changes:");
    syncStatus.recentChanges.forEach((commit: any) => {
      const date = new Date(commit.date);
      const shortHash = commit.hash?.substring(0, 7) || "unknown";
      log.cli(`   - ${shortHash}: ${commit.message} (${date.toLocaleDateString()})`);
    });
  }
}

/**
 * Get severity icon for sync status display
 * TASK 360: Visual indicators for different outdated levels
 */
function getSeverityIcon(severity: string): string {
  switch (severity) {
    case "ancient":
      return "🔴";
    case "very-stale":
      return "🟠";
    case "stale":
      return "🟡";
    default:
      return "⚠️";
  }
}

/**
 * Format session summary for list views
 * TASK 360: Enhanced with sync status display support
 */
export function formatSessionSummary(session: Record<string, any>): void {
  if (!session) return;

  const sessionName = session.session || "unknown";
  // TASK 283: Use formatTaskIdForDisplay() to ensure # prefix
  const taskId = session.taskId ? ` (task: ${formatTaskIdForDisplay(session.taskId)})` : "";
  const branchName = session.branch ? ` [${session.branch}]` : "";

  // TASK 360: Add sync status display if available
  const syncStatus = session.syncStatusDisplay ? ` ${session.syncStatusDisplay}` : "";

  log.cli(`${sessionName}${taskId}${branchName}${syncStatus}`);
}

/**
 * Format session PR details for human-readable output
 */
export function formatSessionPrDetails(result: Record<string, any>): void {
  if (!result) return;

  const sessionName = result.session?.session || result.sessionName || "Unknown";
  const taskId = result.session?.taskId || result.taskId || "";
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
  log.cli(`   Session: ${sessionName}`);
  if (taskId) {
    log.cli(`   Task: ${formatTaskIdForDisplay(taskId)}`);
  }
  log.cli("");

  // PR Information
  log.cli("🔗 Pull Request Information:");
  log.cli(`   Status: ${prStatus}`);
  if (prBranch) {
    log.cli(`   Branch: ${prBranch}`);
  }
  log.cli(`   Base: ${baseBranch}`);
  if (commitHash) {
    log.cli(`   Commit: ${commitHash.substring(0, 8)}`);
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
export function formatSessionApprovalDetails(result: Record<string, any>): void {
  if (!result) return;

  const sessionName = result.session?.session || result.sessionName || "Unknown";
  const taskId = result.session?.taskId || result.taskId || "";
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
  log.cli(`   Session: ${sessionName}`);
  if (taskId) {
    const taskStatusMessage = isNewlyApproved
      ? "(status updated to DONE)"
      : "(already marked as DONE)";
    log.cli(`   Task: ${formatTaskIdForDisplay(taskId)} ${taskStatusMessage}`);
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
export function formatDebugEchoDetails(result: Record<string, any>): void {
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
export function formatRuleDetails(rule: Record<string, any>): void {
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
export function formatRuleSummary(rule: Record<string, any>): void {
  if (!rule) return;

  const ruleId = rule.id || "unknown";
  const description = rule.description ? ` - ${rule.description}` : "";
  const format = rule.format ? ` [${rule.format}]` : "";

  log.cli(`${ruleId}${format}${description}`);
}
