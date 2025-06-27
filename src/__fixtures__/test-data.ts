const TEST_VALUE = 123;

/**
 * Common test fixtures for tests across the application
 * Extract repeated test data into this file to improve test maintainability
 */

/**
 * Mock session data for testing
 */
export const MOCK_SESSIONS = {
  VALID_SESSION: {
    name: "test-session",
    createdAt: "2025-05-01T12:00:00.000Z",
    repoName: "local/project",
    repoPath: "/path/to/repo",
    task: "TEST_VALUE",
  },
  TASK_SESSION: {
    name: "task#042",
    createdAt: "2025-05-01T12:00:00.000Z",
    repoName: "local/project",
    repoPath: "/path/to/repo",
    task: "042",
  },
};

/**
 * Mock tasks for testing
 */
export const MOCK_TASKS = {
  VALID_TASK: {
    id: "#TEST_VALUE",
    title: "Test task",
    status: "TODO",
    description: "A test task",
    specPath: "process/tasks/TEST_VALUE-test-task.md",
  },
  IN_PROGRESS_TASK: {
    id: "#042",
    title: "Another test task",
    status: "IN-PROGRESS",
    description: "Another test task",
    specPath: "process/tasks/042-another-test-task.md",
  },
};

/**
 * Mock repository data for testing
 */
export const MOCK_REPOS = {
  VALID_REPO: {
    path: "/path/to/repo",
    name: "test-repo",
    baseBranch: "main",
  },
};

/**
 * Sample file contents for testing file operations
 */
export const SAMPLE_FILES = {
  TASKS_MD: `# Tasks
  
## Backlog

- [ ] #TEST_VALUE: Test task
- [-] #042: Another test task
- [+] #007: Review task
- [x] #001: Completed task
`,
  PACKAGE_JSON: `{
  "name": "test-project",
  "version": "1.0.0",
  "scripts": {
    "test": "bun test"
  }
}`,
  PR_TEMPLATE: `# Pull Request Description

## Task: #{taskId}

## Changes Made

- Added feature X
- Fixed bug Y
- Improved performance of Z

## Tests

- [ ] Added unit tests
- [ ] Added integration tests
- [ ] All tests pass
`,
};

/**
 * Mock command line arguments for testing CLI commands
 */
export const MOCK_CLI_ARGS = {
  SESSION_START: ["session", "start", "--task", "TEST_VALUE"],
  TASK_LIST: ["tasks", "list", "--json"],
  GIT_PR: ["git", "pr", "--session", "test-session"],
};

/**
 * Mock command outputs for testing expected results
 */
export const MOCK_COMMAND_OUTPUTS = {
  SESSION_LIST: [
    { name: "task#TEST_VALUE", createdAt: "2025-05-01T12:00:00.000Z", repoName: "local/project" },
    { name: "task#042", createdAt: "2025-05-01T12:00:00.000Z", repoName: "local/project" },
  ],
  TASK_LIST: [
    { id: "#TEST_VALUE", title: "Test task", status: "TODO" },
    { id: "#042", title: "Another test task", status: "IN-PROGRESS" },
  ],
};
