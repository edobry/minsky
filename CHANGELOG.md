# Changelog

> **Note:** This changelog references SpecStory conversation histories. See [.specstory/.what-is-this.md](.specstory/.what-is-this.md) for details on the SpecStory artifact system.

## [Unreleased]

### Added
- MCP (Machine Context Protocol) server support for enabling AI agent interaction with Minsky commands
  - Added `fastmcp` dependency for implementing the MCP server
  - Created core MCP server module (`src/mcp/server.ts`) for handling protocol communication
  - Implemented command mapper (`src/mcp/command-mapper.ts`) to bridge between CLI commands and MCP tools
  - Added support for tasks and session commands via MCP tools
  - Added `minsky mcp start` command for launching the MCP server with customizable transport options
  - Structured output formatting to consistently return data in machine-readable formats
  - Support for multiple transport types: stdio (default), SSE, and HTTP streaming
- Initial Bun+TypeScript project setup for the minsky CLI tool
- Domain-driven CLI structure with all business logic in domain modules and CLI logic in command modules
- `git clone` command: clone a repo into an isolated workspace, with session support
- `git branch` command: create a new branch in a session's repo
- `git pr` command: generate a markdown PR document with commit history, file changes, and stats, comparing against the correct base branch (remote HEAD, upstream, main, or master)
- `session` commands: `start`, `list`, `get`, `cd` for managing and navigating agent sessions
- Session database in `$XDG_STATE_HOME/minsky/session-db.json` to track sessions, repos, and branches
- Support for both remote and local repo cloning in session start
- Debug logging for the `git pr` command, enabled via `--debug` and output to stderr only
- Test coverage for PR base branch detection and diff/stat generation
- New `tasks` command with `list`, `get`, and `status` (with `get` and `set`) subcommands for task management
- Support for multiple task backends (Markdown file, placeholder for GitHub Issues)
- Robust Markdown checklist parser for `process/tasks.md` supporting code block skipping, description aggregation, and malformed line filtering
- Shared `resolveRepoPath` utility in `src/domain/repo-utils.ts` for resolving repo paths from CLI options, session DB, or git context
- Comprehensive domain-level tests for all `tasks` logic and repo path resolution
- Added IN-PROGRESS and IN-REVIEW task statuses to tasks. These are represented in markdown checklists by `-` (IN-PROGRESS) and `+` (IN-REVIEW), respectively. All domain logic and tests updated accordingly.
- Enhanced `session start` command to accept an optional `--task <task-id>` flag, allowing sessions to be directly associated with tasks. If provided, the CLI looks up the task, validates it exists, uses the task ID as the session name, and stores the task ID in the session record.
- New session-first-workflow rule to enforce proper session creation and verification before any task implementation
- The rule requires explicit verification of task status, session existence, and working directory before code changes
- Documentation required for session verification steps in all implementation work
- Enhanced minsky-workflow rule with a critical "Session-First Implementation" requirement, mandating session creation and activation before any code examination or modification
- Added `--task <task-id>` option to `minsky session get` command, allowing users to look up sessions by associated task ID. Returns an error if both session name and --task are provided, and supports all existing options including --json. Updated documentation and tests accordingly.
- Added automatic workspace detection for task operations. When a task command is executed from a session repository, Minsky automatically detects this and performs the operation on the main workspace instead. All task commands now support a `--workspace` option to explicitly specify the workspace path.
- Added `session delete` command to remove session repositories and database records. This command supports the `--force` flag to skip confirmation prompts and the `--json` flag for machine-readable output. The command safely handles errors during repository deletion or database updates.
- Added `--all` option to `tasks list` command to show completed (DONE) tasks. By default, the command now only shows tasks that are not marked as DONE.
- Created task specification for task #017 to support both task ID formats (`000` and `#000`) in commands with `--task` option
- Task status commands for creating/updating/querying task status
- Cross-platform clipboard support via clipboardy module
- Session status in minsky session list display
- Support for untagged/anonymous tasks in tasks create command
- Specify task ID to new session via --task (-t) argument
- Session output now includes repo-relative working paths
- Added repoName field to SessionRecord for structured repository storage
- Added task #020 to add a `--task` option to the `git pr` command, allowing users to generate PR descriptions for tasks directly without specifying a session or path
- Created task specification for task #018 to add a `--task <task-id>` option to the `minsky session dir` command, allowing users to look up session directories by their associated task ID
- Created task specification for task #023 to add a task specification path to the task object, which will be displayed by commands that show task details, making it easier to locate and access the full task specification document
- Added task specification path to the task object, which is displayed by the `tasks get` command in both standard and JSON output formats. This makes it easier to locate and access the full task specification document.
- Created task specification for task #024 to fix the `session dir` command logic
- New task for refactoring large methods in GitService, focusing on `prWithDependencies` method (#021)
- Added `--quiet` option to `session start` command that outputs only the session directory path, making it suitable for programmatic use in scripts and automated workflows. When the option is specified, all informational messages are suppressed, and only the essential path is returned.
- Created task specification for task #025 to add a `git approve` command that complements the existing `git pr` command, implementing a prepared-merge workflow for PR review and merging. This workflow allows reviewers to easily merge prepared PRs via fast-forward, ensuring history linearity and cleaner integration.
- Added `--task <task-id>` option to `minsky session dir` command, allowing users to look up session directories by associated task ID. The command now supports both session name and task ID (but not both simultaneously), and provides descriptive error messages for all scenarios.
- Created task specification for task #026 to fix task spec paths to use the standardized format.
- Added comprehensive tests for task spec path resolution in `tasks.specpath.test.ts`
- Added new task #027 to auto-detect session context in session commands
- Added `minsky tasks create` command to create new tasks from specification documents. The command extracts the title and description from the spec file, assigns the next available ID, and adds a checklist item to process/tasks.md. It supports session/repo resolution for proper workspace path handling and outputs the task details in either human-readable or JSON format.
- Added `--task <task-id>` option to `minsky git pr` command, allowing users to generate PR descriptions by specifying a task ID rather than a session or path. The command looks up the session associated with the specified task and generates a PR description using that session's repository.
- Added `git commit` command for staging and committing changes in a single step, with support for automatic staging (can be disabled with `--no-stage`), staging all changes (via `--all`), task ID prefixing for commit messages, and amending commits (via `--amend`). Supports specifying a session or repository path.
- Added `init` command to set up a project for Minsky. This command creates the necessary directory structure for tasks, initializes a tasks.md file, and adds the minsky-workflow rule to either .cursor/rules or .ai/rules based on the selected rule format. It supports interactive prompts via @clack/prompts for missing parameters and resolves repo paths using the same patterns as other commands.
- New `session update` command to sync a session with the main branch
  - Stashes local changes before updating (can be disabled with `--no-stash`)
  - Pulls latest changes from remote
  - Merges specified branch (defaults to main)
  - Pushes changes to remote (can be disabled with `--no-push`)
  - Restores stashed changes after update
  - Handles merge conflicts gracefully
  - Supports custom branch and remote options
- Added filter messages to `tasks list` command to clearly indicate when filters are being applied. Messages are displayed before the task list in non-JSON output mode and include:
  - Status filter message when using `--status` option (e.g., "Showing tasks with status 'TODO'")
  - Active tasks message when not using `--all` option (e.g., "Showing active tasks (use --all to include completed tasks)")
  - Messages are not shown in JSON output to maintain machine-readable format
- Added Session Cleanup Procedures section to the minsky-workflow rule, providing clear guidelines for properly cleaning up completed tasks and sessions using the Minsky CLI commands rather than manual file operations

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._
_See: SpecStory history [2025-04-29_XX-XX-task-004-session-get-task-option](.specstory/history/2025-04-29_XX-XX-task-004-session-get-task-option.md) for implementation details._
_See: SpecStory history [task-id-format-support-specification](.specstory/history/task-id-format-support-specification.md) for task creation._

### Changed
- Improved PR logic to always compare against the correct integration branch (remote HEAD, upstream, main, or master)
- PR output now includes both committed and uncommitted (working directory) changes
- README rewritten for clarity and idiomatic open source style
- All debug output is now opt-in and sent to stderr
- Refactored code to move repo path resolution logic out of `tasks.ts` into a shared utility module
- Updated all `tasks` subcommands to use the shared repo path utility and support `--session` and `--repo` options
- Improved error handling and user feedback for invalid status values in `tasks status set`
- Ensured all code and tests follow best practices for modularity and separation of concerns
- Enhanced git modified files detection to include untracked files in addition to committed and uncommitted changes
- Session repositories are now stored under per-repo directories (e.g., `$XDG_STATE_HOME/minsky/git/<repoName>/<session>`)
- Added `repoName` field to session database records
- Updated session-related commands to handle the new directory structure
- Added repo name normalization for consistent directory naming
- Enhanced session repository storage to use a 'sessions' subdirectory for better organization (e.g., `$XDG_STATE_HOME/minsky/git/<repoName>/sessions/<session>`)
- Added backward compatibility to support existing session repositories in the legacy location
- Completely reimplemented the SessionDB class to handle both legacy and new directory structures
- Added migration capability to move sessions from legacy paths to new paths with sessions subdirectory
- Improved error handling in SessionDB operations to ensure stability during transitions
- Support for HTTPS and SSH git URL normalization in `normalizeRepoName` to produce consistent paths
- Enhanced URL handling to preserve domain names for github.com repositories
- Improved session directory path handling with support for backward compatibility
- Updated implementation to handle both legacy and new session path formats (with "sessions" subdirectory)
- Fixed session lookup by task ID in `session get` and `session dir` commands
- Standardized code style to use double quotes instead of single quotes
- Normalize task IDs consistently by ensuring the '#' prefix is added if missing
- Changed SessionDB.getNewSessionRepoPath to return a string instead of a Promise
- Enhanced task creation workflow to support both title formats: `# Task: Title` (without a task number) and `# Task #XXX: Title` (with a task number). The CLI now automatically assigns the next available task number when no number is provided, updates the title in the file, and renames the file to match the assigned number and title.

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._
_See: SpecStory history [2025-04-29_18-50-task-002-per-repo-session-storage](.specstory/history/2025-04-29_18-50-task-002-per-repo-session-storage.md) for task #002 implementation._
_See: SpecStory history [2025-04-30_01-14-task-002-progress-and-updates](.specstory/history/2025-04-30_01-14-task-002-progress-and-updates.md) for sessions subdirectory enhancement._
_See: SpecStory history [2025-04-29_18-53-starting-task-002.md](.specstory/history/2025-04-29_18-53-starting-task-002.md) for task #002 implementation._
_See: SpecStory history [2025-04-30_17-43-task-002-progress-and-updates.md](.specstory/history/2025-04-30_17-43-task-002-progress-and-updates.md) for task #002 completion._
_See: SpecStory history [2025-05-01_15-41-fix-session-test-failures](.specstory/history/2025-05-01_15-41-fix-session-test-failures.md) for task #022 implementation._

### Fixed
- Fixed issues with empty stats and file lists in PR output by improving base commit detection and diff logic
- Fixed linter/type errors in session DB and domain modules
- Fixed Markdown parser and status setter to ignore code blocks and only update real tasks
- Fixed test reliability and linter errors in domain logic tests
- Fixed a critical bug in session creation where database operations were in the wrong order, causing "Session not found" errors when trying to start a session with a task ID
- Fixed bug in `session dir` command where it returned the wrong path for session repositories, not accounting for the per-repo directory structure.
- Windows-specific path edge cases in several modules
- Better error messages for failed command execution
- Various UI text improvements for clarity
- Incorrect error messages in several commands
- Multiple bugs in task status display
- Fixed repo name normalization to handle more URL formats
- Test failures related to task #002 per-repo session storage implementation
  - Fixed mocking in workspace.test.ts
  - Fixed getSession mocking in repo-utils.test.ts
  - Updated getNewSessionRepoPath test to match implementation
  - Fixed Session DB tests to align with new directory structure
- Fixed `session dir` command to correctly handle both legacy and new session repository paths using SessionDB.getRepoPath method instead of a local function that had an incorrect path structure. The command now returns the correct path for both legacy directories and new directories with the sessions subdirectory.
- Fixed test failures in backend/TaskService tests caused by spec file path inconsistencies, by aligning file naming in test fixtures and improving mock file system behavior to maintain state across test operations.
- Fixed task spec path generation to use standardized format (`process/tasks/<id>-<kebab-case-title>.md`)
- Fixed session mocking in tests to properly handle session record retrieval
- Fixed repository path resolution in tests to properly handle session contexts
- Fixed test failures in domain modules and session implementation tests:
  - Corrected mock expectations in tasks.specpath.test.ts to align with actual implementation behavior
  - Updated repo-utils.test.ts to test the correct fallback behavior when git commands fail
  - Fixed SessionDB.deleteSession tests to properly match the implementation's behavior
  - Corrected startSession.test.ts to use the correct local path handling expectations
  - Fixed minsky tasks list CLI tests by creating proper task spec file structures and directories
  - Updated CLI argument from `--repo` to `--workspace` in task list tests to match implementation
  - Simplified tasks.specpath.test.ts to avoid brittle mocking of internal methods
  - Fixed SessionDB.deleteSession test for empty database to align with implementation
  - Fixed session start command tests by replacing direct module property assignment with proper mock.module approach
  - Fixed tasks list CLI tests by ensuring correct workspace structure for path validation
- Fixed session test and implementation issues from task #022:
  - Fixed getRepoPath in SessionDB to correctly prioritize new paths with sessions/ subdirectory
  - Fixed migrateSessionsToSubdirectory test to properly track the updated sessions
  - Fixed startSession.test.ts to minimize mock dependencies and focus on core functionality
  - Replaced single quotes with double quotes in test files for better linting compliance
  - Improved test stability by avoiding direct manipulation of sessions array
  - Fixed file URL conversion test to accurately reflect expected behavior
  - Added TypeScript declarations for bun:test to fix module resolution errors
  - Fixed type issues in mock implementations and test utility functions
  - Fixed type safety for possibly undefined object properties in tests
  - Fixed git PR test failures by properly mocking execAsync and handling git push commands
  - Fixed lint errors in workspace.test.ts, repo-utils.test.ts, and session.test.ts by converting single quotes to double quotes
  - Added appropriate type signatures to reduce any usage in test files
  - Improved mock implementation of execAsync in git PR tests for better reliability
  - Fixed session dir command implementation to correctly handle both legacy paths and new paths with sessions subdirectory
  - Fixed session dir command tests to reflect correct legacy and new path expectations
  - Updated session dir command error messages to be more informative and aligned with test expectations
  - Implemented missing getSessionByTaskId tests to ensure sessions can be found by their associated task IDs
  - Fixed placeholder tests for git PR to prevent linting errors
- Fixed task creation workflow to not require a task number in the spec title. The CLI now supports both formats: `# Task: Title` (without a number) and `# Task #XXX: Title` (with a number). When creating a task from a spec without a number, the CLI automatically assigns the next available task number, updates the title in the file, and renames the file to match the assigned number and title.
  - Fixed type errors in startSession.ts by using proper import syntax for fs and path modules
  - Updated SessionRecord interface usage to remove the non-existent 'branch' property
  - Fixed repo-utils.test.ts to use proper mocking techniques compatible with Bun's test API
  - Updated test files to use 'test' instead of 'it' for compatibility with Bun's test API

_See: SpecStory history [2023-05-06_13-13-fix-session-test-failures](.specstory/history/2023-05-06_13-13-fix-session-test-failures.md) for task 022 implementation._
_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for CLI and organization fixes._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command fixes._
_See: SpecStory history [2024-02-14_18-30-git-modified-files](.specstory/history/2024-02-14_18-30-git-modified-files.md) for git domain changes._
_See: SpecStory history [002-per-repo-session-storage.md](process/tasks/002-per-repo-session-storage.md) for implementation details._
_See: SpecStory history [2025-05-XX_XX-XX-task-026-fix-task-spec-paths](.specstory/history/2025-05-XX_XX-XX-task-026-fix-task-spec-paths.md) for task #026 implementation details._
_See: SpecStory history [2025-05-01_17-04-task-026-fix-task-spec-paths](.specstory/history/2025-05-01_17-04-task-026-fix-task-spec-paths.md) for task spec path standardization._
_See: SpecStory history [2023-05-15_fixing-task-022-test-failures](.specstory/history/2023-05-15_fixing-task-022-test-failures.md) for test fixes._
_See: SpecStory history [2025-05-01_15-41-fix-session-test-failures](.specstory/history/2025-05-01_15-41-fix-session-test-failures.md) for task #022 implementation progress._
_See: SpecStory history [2025-05-04_20-14-task-022-progress-and-specifications.md](.specstory/history/2025-05-04_20-14-task-022-progress-and-specifications.md) for backend test fixes._

### Security
- Sanitized external command execution to prevent shell injection

### Added
- Task #022 to address remaining test failures and linting issues after task #002 implementation

## [0.39.0] - 2025-04-29

### Changed
- Clarified that `minsky tasks list --json` should be used to query the backlog.

_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for implementation details._

### Fixed
- Fixed import paths in src/cli.ts to use relative paths (./commands/session) instead of absolute paths (./src/commands/session)
- Added missing command imports in src/cli.ts (tasks, git, and init commands)
- Fixed test failures in session command tests by correcting import paths

_See: SpecStory history [2023-05-06_13-13-fix-session-test-failures](.specstory/history/2023-05-06_13-13-fix-session-test-failures.md) for task 022 implementation._

 