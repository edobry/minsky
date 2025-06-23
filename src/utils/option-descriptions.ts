/**
 * Option Descriptions
 *
 * This module provides standardized descriptions for command options across
 * CLI and MCP adapters to ensure consistency in documentation and help text.
 *
 * Descriptions are organized by functional area for easier maintenance.
 */

import { TASK_STATUS_VALUES } from "../domain/tasks/taskConstants.js";

// ------------------------------------------------------------------
// Repository Resolution
// ------------------------------------------------------------------

/**
 * Description for session option
 */
export const _SESSION_DESCRIPTION = "Name of the session to use";

/**
 * Description for repository URI option
 */
export const REPO_DESCRIPTION = "Repository URI (local path, URL, or shorthand)";

/**
 * Description for upstream repository URI option
 */
export const UPSTREAM_REPO_DESCRIPTION = "Upstream repository URI";

// ------------------------------------------------------------------
// Output Format
// ------------------------------------------------------------------

/**
 * Description for JSON output option
 */
export const JSON_DESCRIPTION = "Format output as JSON";

/**
 * Description for debug output option
 */
export const DEBUG_DESCRIPTION = "Show debug information";

// ------------------------------------------------------------------
// Tasks
// ------------------------------------------------------------------

/**
 * Description for task ID option
 */
export const TASK_ID_DESCRIPTION = "ID of the task (with or without # prefix)";

/**
 * Description for task status filter option
 */
export const TASK_STATUS_FILTER_DESCRIPTION = 
  `Filter tasks by status (${TASK_STATUS_VALUES.join(", ")})`;

/**
 * Description for task status option
 */
export const TASK_STATUS_DESCRIPTION = 
  `Task status (${TASK_STATUS_VALUES.join(", ")})`;

/**
 * Description for all tasks option
 */
export const TASK_ALL_DESCRIPTION = "Include all tasks (including completed)";

// ------------------------------------------------------------------
// Backend
// ------------------------------------------------------------------

/**
 * Description for backend type option
 */
export const BACKEND_DESCRIPTION = "Type of backend to use";

/**
 * Description for task backend option
 */
export const TASK_BACKEND_DESCRIPTION = "Backend to use for task management";

// ------------------------------------------------------------------
// Force Options
// ------------------------------------------------------------------

/**
 * Description for force option
 */
export const FORCE_DESCRIPTION = "Force the operation, ignoring warnings";

/**
 * Description for overwrite option
 */
export const OVERWRITE_DESCRIPTION = "Overwrite existing resources if they exist";

// ------------------------------------------------------------------
// Git Options
// ------------------------------------------------------------------

/**
 * Description for git remote option
 */
export const GIT_REMOTE_DESCRIPTION = "Git remote to use";

/**
 * Description for git branch option
 */
export const GIT_BRANCH_DESCRIPTION = "Git branch name";

/**
 * Description for git force option
 */
export const GIT_FORCE_DESCRIPTION = "Force git operations (e.g., push, pull)";

/**
 * Description for no status update option
 */
export const NO_STATUS_UPDATE_DESCRIPTION = "Skip updating task status";

// ------------------------------------------------------------------
// Rules
// ------------------------------------------------------------------

/**
 * Description for rule content option
 */
export const RULE_CONTENT_DESCRIPTION = "Content of the rule (or path to file containing _content)";

/**
 * Description for rule description option
 */
export const RULE_DESCRIPTION_DESCRIPTION = "Description of the rule";

/**
 * Description for rule name option
 */
export const RULE_NAME_DESCRIPTION = "Display name of the rule (defaults to ID)";

/**
 * Description for rule format option
 */
export const RULE_FORMAT_DESCRIPTION = "Format of the rule file (cursor or generic)";

/**
 * Description for rule tags option
 */
export const RULE_TAGS_DESCRIPTION = "Comma-separated list of tags for the rule";

// ------------------------------------------------------------------
// Session Option Descriptions
// ------------------------------------------------------------------

/**
 * Description for the quiet option in session commands
 */
export const SESSION_QUIET_DESCRIPTION = "Only output the session directory path";

/**
 * Description for the repo URL option in remote session commands
 */
export const REPO_URL_DESCRIPTION = "Remote repository URL for remote/github backends";

/**
 * Description for the authentication method option
 */
export const AUTH_METHOD_DESCRIPTION =
  "Authentication method for remote repository (ssh, https, token)";

/**
 * Description for the clone depth option
 */
export const CLONE_DEPTH_DESCRIPTION = "Clone depth for remote repositories";
