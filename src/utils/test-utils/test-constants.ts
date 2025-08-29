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
  BRANCH_SHOW_CURRENT: "branch --show-current",
  COMMIT_EXAMPLE: "abc123 feat: add new feature",
  DIFF_NAME_ONLY: "diff --name-only",
  STATUS_PORCELAIN_COMMAND: "status --porcelain",
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
  MOCK_WORKSPACE: "/mock/workspace",
  MOCK_WORKDIR: "/mock/workdir",
  SESSION_EXPLICIT: "explicit-session",
  MINSKY_SESSIONS_TASK: "/Users/edobry/.local/state/minsky/sessions/task#150",
  MINSKY_MAIN_WORKSPACE: "/Users/edobry/Projects/minsky",
  MINSKY_CONFIG_FILE: "/home/user/.config/minsky/config.yaml",
  OUTSIDE_FILE: "/outside/file.ts",
  TEST_SESSION_WORKSPACE: "/test/session/workspace",
  TEST_SESSION_WORKSPACE_FILE: "/test/session/workspace/src/file.ts",
  MINSKY_SESSIONS_TEST: "/test/minsky/sessions/test-session",
  TEST_BASE_DIR_SESSIONS: "/test/base/dir/sessions/test-session-1",
  TMP_TEST_SESSION: "/tmp/test-session",
  PASSWD_PATH: "../../../etc/passwd",
  TEST_USER_SESSIONS: "/Users/test/.local/state/minsky/sessions/session-name",
} as const;

// Task and session test data
export const TEST_ENTITIES = {
  TASK_TITLE_285: "feat(#285): Fix session PR title duplication bug",
  PR_SUMMARY: "## Summary\n\nThis PR fixes the issue.",
  TASK_DESCRIPTION_AUTH: "Fix the authentication bug",
  SESSION_NAME_CUSTOM: "custom-session",
  SESSION_NAME_ORPHANED: "orphaned-session",
  SESSION_NAME_APPROVED: "approved-session",
  SESSION_NAME_NON_EXISTENT: "non-existent-session",
  SESSION_WITHOUT_PR: "session-without-pr",
  TASK_QUALIFIED_ID: "task#gh:issue-123",
  UPDATED_TASK_TITLE: "Updated Test Task 2",
  BLOCKED_TASK_TITLE: "Add BLOCKED Status Support",
  DESCRIPTION_HERE: "Description here.",
  TEST_DESCRIPTION: "This is a test description.",
} as const;

// Branch and merge patterns
export const BRANCH_PATTERNS = {
  PR_FEATURE_BRANCH: "pr/feature-branch",
  PR_TASK_FEATURE: "pr/task-123-feature",
  PR_TEST_APPROVAL: "pr/test-pr-approval-session",
  ORIGIN_MAIN_DUPLICATE: "origin/origin/main",
  FEATURE_TASK_123: "feature/task-123",
} as const;

// File content patterns
export const FILE_CONTENT = {
  LINE_1_2_3: "line 1\nline 2\nline 3",
  MODIFIED_LINE_CONTENT: "line 1\nmodified line 2\nline 3",
  NEW_FILE_CONTENT: "new file content\nline 2",
  EXISTING_CODE_COMMENT: "// ... existing code ...",
  CREATE_NEW_FILE: "Create a new file",
  MODIFIED_STATUS: "M  src/file1.ts\n",
} as const;

// Command and CLI patterns
export const CLI_COMMANDS = {
  MINSKY_TASKS_LIST: "minsky tasks list",
  MINSKY_SESSIONS_LIST: "minsky sessions list",
  MINSKY_SESSION_START_TASK: "minsky session start --task 123",
  MCP_MINSKY_TASKS_LIST: "mcp_minsky-server_tasks_list",
  SHOWING_ACTIVE_TASKS: "Showing active tasks (use --all to include completed tasks)",
  JSONSCHEMA_FUNCTIONS_AVAILABLE: "Here are the functions available in JSONSchema format:",
} as const;

// Error and validation messages
export const ERROR_MESSAGES = {
  SESSION_PARAMETER_REQUIRED: "Session parameter is required",
  PERMISSION_DENIED: "Permission denied",
  WITHOUT_UNDERSCORE: "without_underscore",
  FAILED_UNSET_CONFIG_PERMISSION: "Failed to unset configuration: Permission denied",
} as const;

// Rules and content
export const RULE_CONTENT = {
  CURSOR_ONLY_RULE: "cursor-only-rule",
  GENERIC_ONLY_RULE: "generic-only-rule",
  CURSOR_RULE_CONTENT: "Cursor rule content",
  GENERIC_RULE_CONTENT: "Generic rule content",
  THIS_APPEARS_CLI: "This appears for CLI",
  THIS_APPEARS_MCP: "This appears for MCP",
} as const;

// Network and API
export const NETWORK_CONSTANTS = {
  APPLICATION_JSON: "application/json",
  GIT_PUSH_WITH_TIMEOUT: "gitPushWithTimeout",
  GIT_FETCH_WITH_TIMEOUT: "gitFetchWithTimeout",
} as const;

// Test behavior patterns
export const TEST_BEHAVIORS = {
  CREATES_MOCK_DEFAULT: "creates a mock with default behavior",
  ACCEPTS_METHOD_OVERRIDES: "accepts method overrides",
} as const;

// File paths and spec paths
export const SPEC_PATHS = {
  PROCESS_TASKS_001: "process/tasks/001-test-task.md",
  PROCESS_TASKS_MD999: "process/tasks/md#999-test-integration.md",
  TYPESCRIPT_SIMPLE_CLASS: "typescript/simple-class.ts",
  TYPESCRIPT_INTERFACE_DEFINITIONS: "typescript/interface-definitions.ts",
  MOCK_LOGGER_PATH: "../src/utils/test-utils/mock-logger",
} as const;

// Skip messages
export const SKIP_MESSAGES = {
  MORPH_NOT_CONFIGURED: "⏭️  Skipping test - Morph provider not configured",
  MORPH_SKIPPING: "⏭️  Skipping - Morph not configured",
} as const;

// Session patterns for tests
export const SESSION_TEST_PATTERNS = {
  WORKSPACE_SESSION: "workspace-session",
  DIRECTORY_SESSION: "directory-session",
  URL_TEST_SESSION: "url-test-session",
  TEST_USERS_SESSIONS: "/Users/test/.local/state/minsky/sessions/session-name",
  ORPHANED_SESSION: "orphaned-session",
  NON_EXISTENT_SESSION: "non-existent-session",
  APPROVED_SESSION: "approved-session",
  SESSION_WITHOUT_PR: "session-without-pr",
  PR_TEST_APPROVAL_SESSION: "pr/test-pr-approval-session",
  PR_FEATURE_BRANCH: "pr/feature-branch",
  PR_TASK_123_FEATURE: "pr/task-123-feature",
} as const;

// Diff test content patterns
export const DIFF_TEST_CONTENT = {
  THREE_LINES: "line 1\nline 2\nline 3",
  TWO_LINES: "line 1\nline 2",
  MODIFIED_THREE_LINES: "line 1\nmodified line 2\nline 3",
  FOUR_LINES: "line 1\nline 2\nline 3\nline 4",
  TWO_LINES_ONLY: "line 1\nline 3",
  FOUR_TO_TWO: "line 1\nline 4",
} as const;

// Git and repository patterns
export const GIT_TEST_PATTERNS = {
  SSH_REPO_URL: "git@github.com:org/repo.git",
  PERMISSION_DENIED: "Permission denied",
  ORIGIN_MAIN: "origin/origin/main",
  GIT_PUSH_WITH_TIMEOUT: "gitPushWithTimeout",
  GIT_FETCH_WITH_TIMEOUT: "gitFetchWithTimeout",
  BRANCH_SHOW_CURRENT: "branch --show-current",
  SAMPLE_COMMIT: "abc123 feat: add new feature",
  STASH_POP: 'stash pop "stash@{0}"',
  GIT_STATUS_MODIFIED: "M  src/file1.ts\n",
  DIFF_NAME_ONLY: "diff --name-only",
} as const;

// Rules and context patterns
export const RULES_TEST_PATTERNS = {
  DOMAIN_ORIENTED_MODULES: "domain-oriented-modules",
  DESCRIPTION_PLACEHOLDER: "Description here.",
  CURSOR_ONLY_RULE: "cursor-only-rule",
  GENERIC_ONLY_RULE: "generic-only-rule",
  CURSOR_RULE_CONTENT: "Cursor rule content",
  GENERIC_RULE_CONTENT: "Generic rule content",
} as const;

// Test data patterns
export const TEST_DATA_PATTERNS = {
  UPDATED_TASK_TITLE: "Updated Test Task 2",
  TEST_DESCRIPTION: "This is a test description.",
  TASK_GH_ID: "task#gh:issue-123",
} as const;

// Configuration patterns
export const CONFIG_TEST_PATTERNS = {
  SESSIONDB_BACKEND: "sessiondb.backend",
  OPENAI_MODEL_PATH: "ai.providers.openai.model",
} as const;

// File path patterns
export const PATH_TEST_PATTERNS = {
  TASK_MD_001: "process/tasks/001-test-task.md",
  TASK_MD_999: "process/tasks/md#999-test-integration.md",
  MOCK_FILE_PATH: "/path/to/file.txt",
  TMP_TEST_SESSION: "/tmp/test-session",
  FEATURE_TASK_BRANCH: "feature/task-123",
  TEST_SESSION_PATH: "/test/minsky/sessions/test-session",
  TEST_SESSION_1_PATH: "/test/base/dir/sessions/test-session-1",
  ETC_PASSWD_PATH: "../../../etc/passwd",
} as const;

// Code comment patterns
export const CODE_TEST_PATTERNS = {
  EXISTING_CODE_COMMENT: "// ... existing code ...",
  SKIPPING_MORPH_MESSAGE: "⏭️  Skipping - Morph not configured",
  CLI_MESSAGE: "This appears for CLI",
  MCP_MESSAGE: "This appears for MCP",
  SKIPPING_TEST_MORPH: "⏭️  Skipping test - Morph provider not configured",
} as const;

// UI and content patterns
export const UI_TEST_PATTERNS = {
  CREATE_NEW_FILE: "Create a new file",
  NEW_FILE_CONTENT: "new file content\nline 2",
  SHOWING_ACTIVE_TASKS: "Showing active tasks (use --all to include completed _tasks)",
  PR_SUMMARY: "## Summary\n\nThis PR fixes the issue.",
} as const;

// Test description patterns
export const TEST_DESC_PATTERNS = {
  CREATES_MOCK_DEFAULT: "creates a mock with default behavior",
  ACCEPTS_METHOD_OVERRIDES: "accepts method overrides",
} as const;
