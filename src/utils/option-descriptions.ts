/**
 * Option Descriptions
 * 
 * This module provides centralized option and parameter descriptions
 * for consistent usage across CLI and MCP interfaces in the Minsky project.
 * Descriptions are grouped by functional area to aid discoverability.
 */

// ------------------------------------------------------------------
// Repository Resolution Option Descriptions
// ------------------------------------------------------------------

/**
 * Description for the session option used in repository resolution
 */
export const SESSION_DESCRIPTION = "Session name to use for repository resolution";

/**
 * Description for the repo option used in repository resolution
 */
export const REPO_DESCRIPTION = "Repository URI (overrides session)";

/**
 * Description for the upstream repo option used in repository resolution
 */
export const UPSTREAM_REPO_DESCRIPTION = "URI of the upstream repository (overrides repo and session)";

// ------------------------------------------------------------------
// Output Format Option Descriptions
// ------------------------------------------------------------------

/**
 * Description for the JSON output option
 */
export const JSON_DESCRIPTION = "Output result as JSON";

/**
 * Description for the debug output option
 */
export const DEBUG_DESCRIPTION = "Enable debug output";

// ------------------------------------------------------------------
// Task Option Descriptions
// ------------------------------------------------------------------

/**
 * Description for the task ID option
 */
export const TASK_ID_DESCRIPTION = "Task ID to match";

/**
 * Description for the task status filter option
 */
export const TASK_STATUS_FILTER_DESCRIPTION = "Filter tasks by status";

/**
 * Description for the task status option
 */
export const TASK_STATUS_DESCRIPTION = "Status to set (TODO, IN-PROGRESS, IN-REVIEW, DONE)";

/**
 * Description for the all tasks option
 */
export const TASK_ALL_DESCRIPTION = "Include completed tasks";

// ------------------------------------------------------------------
// Backend Option Descriptions
// ------------------------------------------------------------------

/**
 * Description for the backend type option
 */
export const BACKEND_DESCRIPTION = "Specify backend type";

/**
 * Description for the task backend option
 */
export const TASK_BACKEND_DESCRIPTION = "Task backend (markdown, github)";

// ------------------------------------------------------------------
// Force Option Descriptions
// ------------------------------------------------------------------

/**
 * Description for the force operation option
 */
export const FORCE_DESCRIPTION = "Force the operation even with validation warnings or errors";

/**
 * Description for the overwrite option
 */
export const OVERWRITE_DESCRIPTION = "Overwrite existing files";

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
export const AUTH_METHOD_DESCRIPTION = "Authentication method for remote repository (ssh, https, token)";

/**
 * Description for the clone depth option
 */
export const CLONE_DEPTH_DESCRIPTION = "Clone depth for remote repositories";

// ------------------------------------------------------------------
// Git Option Descriptions
// ------------------------------------------------------------------

/**
 * Description for the remote option in git commands
 */
export const GIT_REMOTE_DESCRIPTION = "Remote to push to (defaults to origin)";

/**
 * Description for the branch option in git commands
 */
export const GIT_BRANCH_DESCRIPTION = "Branch name";

/**
 * Description for the git force option
 */
export const GIT_FORCE_DESCRIPTION = "Force push (use with caution)";

/**
 * Description for the no status update option
 */
export const NO_STATUS_UPDATE_DESCRIPTION = "Skip updating task status";

// ------------------------------------------------------------------
// Rules Option Descriptions
// ------------------------------------------------------------------

/**
 * Description for rule content option
 */
export const RULE_CONTENT_DESCRIPTION = "Content of the rule (or path to file containing content)";

/**
 * Description for rule description option
 */
export const RULE_DESCRIPTION_DESCRIPTION = "Description of the rule";

/**
 * Description for rule name option
 */
export const RULE_NAME_DESCRIPTION = "Display name of the rule";

/**
 * Description for rule globs option
 */
export const RULE_GLOBS_DESCRIPTION = "Comma-separated list or JSON array of glob patterns to match files";

/**
 * Description for rule tags option
 */
export const RULE_TAGS_DESCRIPTION = "Comma-separated list of tags for the rule";

/**
 * Description for rule format option
 */
export const RULE_FORMAT_DESCRIPTION = "Format of the rule file"; 
