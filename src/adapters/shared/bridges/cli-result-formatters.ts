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
 */
export function formatSessionDetails(session: Record<string, unknown>): void {
  if (!session) return;

  // Display session information in a user-friendly format
  log.cli("📄 Session Details:");
  log.cli("");

  if (session.id) log.cli(`   ID: ${session.id}`);
  if (session.name) log.cli(`   Name: ${session.name}`);
  if (session.status) log.cli(`   Status: ${session.status}`);
  if (session.taskId) log.cli(`   Task ID: ${formatTaskIdForDisplay(session.taskId)}`);
  if (session.branchName) log.cli(`   Branch: ${session.branchName}`);
  if (session.workspacePath) log.cli(`   Workspace: ${session.workspacePath}`);
  if (session.repoUrl) log.cli(`   Repository: ${session.repoUrl}`);
  if (session.createdAt) {
    const date = new Date(session.createdAt);
    log.cli(`   Created: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
  }
  if (session.lastUpdated) {
    const date = new Date(session.lastUpdated);
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

  const sessionName = session.session || "unknown";
  // TASK 283: Use formatTaskIdForDisplay() to ensure # prefix
  const taskId = session.taskId ? ` (task: ${formatTaskIdForDisplay(session.taskId)})` : "";
  const branchName = session.branch ? ` [${session.branch}]` : "";

  // Sessions don't have status - that's a task concept
  log.cli(`${sessionName}${taskId}${branchName}`);
}

/**
 * Format session PR details for human-readable output
 */
export function formatSessionPrDetails(result: Record<string, unknown>): void {
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
export function formatSessionApprovalDetails(result: Record<string, unknown>): void {
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
