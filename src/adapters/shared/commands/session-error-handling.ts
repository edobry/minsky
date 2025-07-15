/**
 * Session Command Error Handling
 *
 * This module contains error handling utilities for session commands,
 * extracted from the main session commands file for better organization.
 */

import { MinskyError } from "../../../errors/index";
import { getErrorMessage } from "../../../errors/index";

/**
 * Handle session PR command errors with user-friendly messages
 */
export function handleSessionPrError(error: Error, sessionName?: string, taskId?: string): never {
  const errorMessage = getErrorMessage(error);

  // Handle specific error types with friendly messages
  if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
    throw new MinskyError(
      `🔥 Git merge conflict detected while creating PR branch.

This usually happens when:
• The PR branch already exists with different content
• There are conflicting changes between your session and the base branch

💡 Quick fixes:
• Try with --skip-update to avoid session updates
• Or manually resolve conflicts and retry

Technical details: ${errorMessage}`
    );
  }

  if (errorMessage.includes("Failed to create prepared merge commit")) {
    throw new MinskyError(
      `❌ Failed to create PR branch merge commit.

This could be due to:
• Merge conflicts between your session branch and base branch
• Remote PR branch already exists with different content
• Network issues with git operations

💡 Try these solutions:
• Run 'git status' to check for conflicts
• Use --skip-update to bypass session updates
• Check your git remote connection

Technical details: ${errorMessage}`
    );
  }

  if (errorMessage.includes("Permission denied") || errorMessage.includes("authentication")) {
    throw new MinskyError(
      `🔐 Git authentication error.

Please check:
• Your SSH keys are properly configured
• You have push access to the repository
• Your git credentials are valid

Technical details: ${errorMessage}`
    );
  }

  if (errorMessage.includes("Session") && errorMessage.includes("not found")) {
    throw new MinskyError(
      `🔍 Session not found.

The session '${sessionName || taskId}' could not be located.

💡 Try:
• Check available sessions: minsky session list
• Verify you're in the correct directory
• Use the correct session name or task ID

Technical details: ${errorMessage}`
    );
  }

  // For other errors, provide a general helpful message
  throw new MinskyError(
    `❌ Failed to create session PR.

The operation failed with: ${errorMessage}

💡 Troubleshooting:
• Check that you're in a session workspace
• Verify all files are committed
• Try running with --debug for more details
• Check 'minsky session list' to see available sessions

Need help? Run the command with --debug for detailed error information.`
  );
}

/**
 * Validate PR parameters and provide user-friendly error messages
 */
export function validatePrParameters(
  body?: string,
  bodyPath?: string,
  sessionName?: string
): { shouldRequireBody: boolean; validationError?: string } {
  // Import gitService for validation
  const currentDir = process.cwd();
  const isSessionWorkspace = currentDir.includes("/sessions/");

  let actualSessionName = sessionName;
  if (!actualSessionName && isSessionWorkspace) {
    // Try to detect session name from current directory
    const pathParts = currentDir.split("/");
    const sessionsIndex = pathParts.indexOf("sessions");
    if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
      actualSessionName = pathParts[sessionsIndex + 1];
    }
  }

  // If we can't determine the session name, let the main function handle it
  if (!actualSessionName) {
    return { shouldRequireBody: true };
  }

  // For now, return that body is required - async PR branch checking will be done in the main function
  return { shouldRequireBody: true };
}

/**
 * Generate user-friendly error message for missing PR body
 */
export function generateMissingBodyErrorMessage(): string {
  return `PR description is required for meaningful pull requests.
Please provide one of:
  --body <text>       Direct PR body text
  --body-path <path>  Path to file containing PR body

Example:
  minsky session pr --title "feat: Add new feature" --body "This PR adds..."
  minsky session pr --title "fix: Bug fix" --body-path process/tasks/189/pr.md`;
}

/**
 * Generate user-friendly error message for missing task association
 */
export function generateMissingTaskAssociationErrorMessage(): string {
  return `Task association is required for proper tracking.
Please provide one of:
  --task <id>           Associate with existing task
  --description <text>  Create new task automatically

Examples:
  minsky session start --task 123
  minsky session start --description "Fix login issue" my-session`;
}
