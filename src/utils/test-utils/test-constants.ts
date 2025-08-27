/**
 * Test Constants
 * 
 * Centralized constants for test files to prevent magic string duplication.
 * Extract common test strings here to improve maintainability.
 */

// Git-related constants
export const GIT_COMMANDS = {
  STATUS_PORCELAIN: 'git status --porcelain',
  ADD_TASKS_MD: 'git add process/tasks.md',
  CHECKOUT_MAIN: 'git checkout main',
  FETCH_ORIGIN: 'git fetch origin',
  REV_PARSE_HEAD: 'git rev-parse HEAD',
  CONFIG_USER_NAME: 'git config user.name',
  PUSH_ORIGIN_MAIN: 'git push origin main',
  REV_PARSE_ABBREV_REF_HEAD: 'rev-parse --abbrev-ref HEAD',
  STASH_POP_ZERO: 'stash pop "stash@{0}"',
} as const;

// Repository URIs
export const REPO_URIS = {
  GITHUB_SSH: 'git@github.com:org/repo.git',
} as const;

// Test paths
export const TEST_PATHS = {
  SESSION_MD_160: '/test/sessions/task-md#160',
  CURRENT_DIRECTORY: '/current/directory',
  MOCK_ROOT: '/mock/r',
  MOCK_WORKSPACE: '/mock/workspace',
  MOCK_WORKDIR: '/mock/workdir',
  SESSION_EXPLICIT: 'explicit-session',
  MINSKY_SESSIONS_TASK: '/Users/edobry/.local/state/minsky/sessions/task#150',
  OUTSIDE_FILE: '/outside/file.ts',
  TEST_SESSION_WORKSPACE: '/test/session/workspace',
  TEST_SESSION_WORKSPACE_FILE: '/test/session/workspace/src/file.ts',
  MINSKY_SESSIONS_TEST: '/test/minsky/sessions/test-session',
  TEST_BASE_DIR_SESSIONS: '/test/base/dir/sessions/test-session-1',
  TMP_TEST_SESSION: '/tmp/test-session',
  PASSWD_PATH: '../../../etc/passwd',
} as const;

// Task and session test data
export const TEST_ENTITIES = {
  TASK_TITLE_285: 'feat(#285): Fix session PR title duplication bug',
  PR_SUMMARY: '## Summary\n\nThis PR fixes the issue.',
  TASK_DESCRIPTION_AUTH: 'Fix the authentication bug',
  SESSION_NAME_CUSTOM: 'custom-session',
  SESSION_NAME_ORPHANED: 'orphaned-session',
  SESSION_NAME_APPROVED: 'approved-session',
  SESSION_NAME_NON_EXISTENT: 'non-existent-session',
  SESSION_WITHOUT_PR: 'session-without-pr',
  TASK_QUALIFIED_ID: 'task#gh:issue-123',
  UPDATED_TASK_TITLE: 'Updated Test Task 2',
  BLOCKED_TASK_TITLE: 'Add BLOCKED Status Support',
  DESCRIPTION_HERE: 'Description here.',
  TEST_DESCRIPTION: 'This is a test description.',
} as const;

// Branch and merge patterns
export const BRANCH_PATTERNS = {
  PR_FEATURE_BRANCH: 'pr/feature-branch',
  PR_TASK_FEATURE: 'pr/task-123-feature',
  PR_TEST_APPROVAL: 'pr/test-pr-approval-session',
  ORIGIN_MAIN_DUPLICATE: 'origin/origin/main',
  FEATURE_TASK_123: 'feature/task-123',
} as const;

// File content patterns
export const FILE_CONTENT = {
  LINE_1_2_3: 'line 1\nline 2\nline 3',
  MODIFIED_LINE_CONTENT: 'line 1\nmodified line 2\nline 3',
  NEW_FILE_CONTENT: 'new file content\nline 2',
  EXISTING_CODE_COMMENT: '// ... existing code ...',
  CREATE_NEW_FILE: 'Create a new file',
  MODIFIED_STATUS: 'M  src/file1.ts\n',
} as const;

// Command and CLI patterns
export const CLI_COMMANDS = {
  MINSKY_TASKS_LIST: 'minsky tasks list',
  MINSKY_SESSIONS_LIST: 'minsky sessions list',
  MINSKY_SESSION_START_TASK: 'minsky session start --task 123',
  MCP_MINSKY_TASKS_LIST: 'mcp_minsky-server_tasks_list',
  SHOWING_ACTIVE_TASKS: 'Showing active tasks (use --all to include completed tasks)',
} as const;

// Error and validation messages
export const ERROR_MESSAGES = {
  SESSION_PARAMETER_REQUIRED: 'Session parameter is required',
  PERMISSION_DENIED: 'Permission denied',
  WITHOUT_UNDERSCORE: 'without_underscore',
} as const;

// Rules and content
export const RULE_CONTENT = {
  CURSOR_ONLY_RULE: 'cursor-only-rule',
  GENERIC_ONLY_RULE: 'generic-only-rule',
  CURSOR_RULE_CONTENT: 'Cursor rule content',
  GENERIC_RULE_CONTENT: 'Generic rule content',
  THIS_APPEARS_CLI: 'This appears for CLI',
  THIS_APPEARS_MCP: 'This appears for MCP',
} as const;

// Network and API
export const NETWORK_CONSTANTS = {
  APPLICATION_JSON: 'application/json',
  GIT_PUSH_WITH_TIMEOUT: 'gitPushWithTimeout',
  GIT_FETCH_WITH_TIMEOUT: 'gitFetchWithTimeout',
} as const;

// Test behavior patterns
export const TEST_BEHAVIORS = {
  CREATES_MOCK_DEFAULT: 'creates a mock with default behavior',
  ACCEPTS_METHOD_OVERRIDES: 'accepts method overrides',
} as const;

// File paths and spec paths
export const SPEC_PATHS = {
  PROCESS_TASKS_001: 'process/tasks/001-test-task.md',
  PROCESS_TASKS_MD999: 'process/tasks/md#999-test-integration.md',
  TYPESCRIPT_SIMPLE_CLASS: 'typescript/simple-class.ts',
  TYPESCRIPT_INTERFACE_DEFINITIONS: 'typescript/interface-definitions.ts',
  MOCK_LOGGER_PATH: '../src/utils/test-utils/mock-logger',
} as const;

// Skip messages
export const SKIP_MESSAGES = {
  MORPH_NOT_CONFIGURED: '⏭️  Skipping test - Morph provider not configured',
  MORPH_SKIPPING: '⏭️  Skipping - Morph not configured',
} as const;

// Session patterns for tests
export const SESSION_TEST_PATTERNS = {
  WORKSPACE_SESSION: 'workspace-session',
  DIRECTORY_SESSION: 'directory-session',
  URL_TEST_SESSION: 'url-test-session',
  TEST_USERS_SESSIONS: '/Users/test/.local/state/minsky/sessions/session-name',
} as const;
