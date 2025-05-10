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
    task: "123"
  },
  TASK_SESSION: {
    name: "task#042",
    createdAt: "2025-05-01T12:00:00.000Z",
    repoName: "local/project",
    repoPath: "/path/to/repo",
    task: "042"
  }
};

/**
 * Mock tasks for testing
 */
export const MOCK_TASKS = {
  VALID_TASK: {
    id: "#123",
    title: "Test task",
    status: "TODO",
    description: "A test task",
    specPath: "process/tasks/123-test-task.md"
  },
  IN_PROGRESS_TASK: {
    id: "#042",
    title: "Another test task",
    status: "IN-PROGRESS",
    description: "Another test task",
    specPath: "process/tasks/042-another-test-task.md"
  }
};

/**
 * Mock repository data for testing
 */
export const MOCK_REPOS = {
  VALID_REPO: {
    path: "/path/to/repo",
    name: "test-repo",
    baseBranch: "main"
  }
};

/**
 * Sample file contents for testing file operations
 */
export const SAMPLE_FILES = {
  TASKS_MD: `# Tasks
  
## Backlog

- [ ] #123: Test task
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
`
};

/**
 * Mock command line arguments for testing CLI commands
 */
export const MOCK_CLI_ARGS = {
  SESSION_START: ["session", "start", "--task", "123"],
  TASK_LIST: ["tasks", "list", "--json"],
  GIT_PR: ["git", "pr", "--session", "test-session"]
};

/**
 * Mock command outputs for testing expected results
 */
export const MOCK_COMMAND_OUTPUTS = {
  SESSION_LIST: [
    { name: "task#123", createdAt: "2025-05-01T12:00:00.000Z", repoName: "local/project" },
    { name: "task#042", createdAt: "2025-05-01T12:00:00.000Z", repoName: "local/project" }
  ],
  TASK_LIST: [
    { id: "#123", title: "Test task", status: "TODO" },
    { id: "#042", title: "Another test task", status: "IN-PROGRESS" }
  ]
}; 
