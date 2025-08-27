/**
 * Test Constants
 *
 * Centralized constants for test files to prevent magic string duplication.
 * Extract common test strings here to improve maintainability.
 */

// Git-related constants
export const GIT_COMMANDS = {
  STATUS_PORCELAIN: "git status --porcelain",
  ADD_TASKS_MD: "git add process/tasks.md",
  CHECKOUT_MAIN: "git checkout main",
  FETCH_ORIGIN: "git fetch origin",
  REV_PARSE_HEAD: "git rev-parse HEAD",
  CONFIG_USER_NAME: "git config user.name",
  PUSH_ORIGIN_MAIN: "git push origin main",
  REV_PARSE_ABBREV_REF_HEAD: "rev-parse --abbrev-ref HEAD",
  STASH_POP_ZERO: 'stash pop "stash@{0}"',
} as const;

// Repository URIs
export const REPO_URIS = {
  GITHUB_SSH: "git@github.com:org/repo.git",
} as const;

// Test paths
export const TEST_PATHS = {
  SESSION_MD_160: "/test/sessions/task-md#160",
  CURRENT_DIRECTORY: "/current/directory",
  MOCK_ROOT: "/mock/r",
  MOCK_WORKSPACE: "/mock/w",
  OUTSIDE_FILE: "/outside/file.ts",
  SESSION_WORKSPACE: "/test/session/workspace",
  SESSION_WORKSPACE_FILE: "/test/session/workspace/src/file.ts",
  BASE_DIR_SESSION: "/test/base/dir/sessions/test-session-1",
  MINSKY_SESSION: "/test/minsky/sessions/test-session",
  TMP_TEST_SESSION: "/tmp/test-session",
  PATH_TO_FILE: "/path/to/file.txt",
  ETC_PASSWD_TRAVERSAL: "../../../etc/passwd",
} as const;

// Task and session names
export const TEST_ENTITIES = {
  TASK_TITLE_285: "feat(#285): Fix session PR title duplication bug",
  PR_SUMMARY: "## Summary\n\nThis PR fixes the issue.",
  BLOCKED_STATUS_TASK: "Add BLOCKED Status Support",
  AUTHENTICATION_BUG: "Fix the authentication bug",
  ORPHANED_SESSION: "orphaned-session",
  APPROVED_SESSION: "approved-session",
  SESSION_WITHOUT_PR: "session-without-pr",
  NON_EXISTENT_SESSION: "non-existent-session",
  URL_TEST_SESSION: "url-test-session",
  WORKSPACE_SESSION: "workspace-session",
  DIRECTORY_SESSION: "directory-session",
} as const;

// Branch names
export const BRANCH_NAMES = {
  PR_FEATURE_BRANCH: "pr/feature-branch",
  FEATURE_TASK_123: "feature/task-123",
  PR_TASK_123_FEATURE: "pr/task-123-feature",
  PR_TEST_PR_APPROVAL: "pr/test-pr-approval-session",
  ORIGIN_ORIGIN_MAIN: "origin/origin/main",
} as const;

// CLI commands and MCP identifiers
export const CLI_COMMANDS = {
  MINSKY_TASKS_LIST: "minsky tasks list",
  MINSKY_SESSION_START_123: "minsky session start --task 123",
  MINSKY_SESSIONS_LIST: "minsky sessions list",
  MCP_TASKS_LIST: "mcp_minsky-server_tasks_list",
} as const;

// Test descriptions and content
export const TEST_CONTENT = {
  CLI_APPEARS: "This appears for CLI",
  MCP_APPEARS: "This appears for MCP",
  DESCRIPTION_HERE: "Description here.",
  TEST_DESCRIPTION: "This is a test description.",
  PERMISSION_DENIED: "Permission denied",
  WITHOUT_UNDERSCORE: "without_underscore",
  CREATE_NEW_FILE: "Create a new file",
  CREATES_MOCK_DEFAULT: "creates a mock with default behavior",
  ACCEPTS_METHOD_OVERRIDES: "accepts method overrides",
  MULTILINE_CONTENT: "line 1\nline 2\nline 3",
  MULTILINE_MODIFIED: "line 1\nmodified line 2\nline 3",
  NEW_FILE_CONTENT: "new file content\nline 2",
  GIT_STATUS_MODIFIED: "M  src/file1.ts\n",
  EXISTING_CODE_COMMENT: "// ... existing code ...",
} as const;

// File and task paths
export const FILE_PATHS = {
  TASKS_001: "process/tasks/001-test-task.md",
  TASKS_MD_999: "process/tasks/md#999-test-integration.md",
  TYPESCRIPT_SIMPLE_CLASS: "typescript/simple-class.ts",
  TYPESCRIPT_INTERFACE_DEFINITIONS: "typescript/interface-definitions.ts",
  MOCK_LOGGER_PATH: "../src/utils/test-utils/mock-logger",
} as const;

// Rule and content types
export const RULE_TYPES = {
  CURSOR_ONLY: "cursor-only-rule",
  GENERIC_ONLY: "generic-only-rule",
  CURSOR_CONTENT: "Cursor rule content",
  GENERIC_CONTENT: "Generic rule content",
} as const;

// Task and backend identifiers
export const TASK_IDS = {
  QUALIFIED_GH_123: "task#gh:issue-123",
  UPDATED_TASK_2: "Updated Test Task 2",
} as const;

// Network and API constants
export const NETWORK_CONSTANTS = {
  APPLICATION_JSON: "application/json",
  GIT_PUSH_TIMEOUT: "gitPushWithTimeout",
  GIT_FETCH_TIMEOUT: "gitFetchWithTimeout",
} as const;

// Filter and status messages
export const STATUS_MESSAGES = {
  SHOWING_ACTIVE_TASKS: "Showing active tasks (use --all to include completed tasks)",
  SKIPPING_MORPH_NOT_CONFIGURED: "⏭️  Skipping test - Morph provider not configured",
  SKIPPING_MORPH: "⏭️  Skipping - Morph not configured",
} as const;

// Session paths for test state directories
export const SESSION_PATHS = {
  USER_LOCAL_STATE: "/Users/test/.local/state/minsky/sessions/session-n...",
} as const;
