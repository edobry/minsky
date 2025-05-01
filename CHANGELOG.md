# Changelog

> **Note:** This changelog references SpecStory conversation histories. See [.specstory/.what-is-this.md](.specstory/.what-is-this.md) for details on the SpecStory artifact system.

## [Unreleased]

### Added
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
- Fixed test failures arising from inconsistent session path handling
- Fixed task ID normalization to handle IDs with and without '#' prefix
- Resolved mismatch between implementation and test expectations in repo path handling 
- Fixed error handling in session lookup by task ID
- Fixed `normalizeRepoName` to preserve domain names for GitHub URLs to match test expectations
- Updated `SessionDB` to handle both legacy and session-subdirectory formats for backward compatibility
- Fixed path handling in sessions to support session paths both with and without the "sessions" subdirectory
- Fixed task ID normalization to consistently handle task IDs with or without the "#" prefix
- Fixed quote style consistency by converting single quotes to double quotes in test files to match project style
- Updated tests to properly mock external dependencies like file system operations
- Fixed test expectations to match the actual implementation of various session and repo utility functions
- Fixed TypeScript errors in tests by properly typing mock functions and variables
- Fixed mocking approach in testing by using mock.module instead of global object replacement
- Fixed fs.access mocking to correctly handle PathLike types
- Fixed startSession.test.ts to use proper import statements and test structure
- Fixed syntax error in delete.test.ts JSON parse statement
- Updated test files to follow consistent double-quote string conventions
- Fixed test failures and linting issues throughout the codebase
- Improved task ID normalization in SessionDB.getSessionByTaskId
- Fixed path handling in SessionDB.getRepoPath for cases with missing repoName
- Fixed GitService.clone to properly handle local file paths
- Updated PR generation to handle empty repositories
- Updated tests to use double quotes instead of single quotes
- Fixed session repository path structure to include "sessions" subdirectory
- Fixed test failures in SessionDB class by properly defining methods on prototype
- Fixed GitService.clone method to avoid session database errors
- Fixed string quotes in test files to use double quotes consistently
- Updated mock setup in git.test.ts for proper execAsync mocking
- Fixed type errors in the SessionRecord interface implementation

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for CLI and organization fixes._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command fixes._
_See: SpecStory history [2024-02-14_18-30-git-modified-files](.specstory/history/2024-02-14_18-30-git-modified-files.md) for git domain changes._
_See: SpecStory history [002-per-repo-session-storage.md](process/tasks/002-per-repo-session-storage.md) for implementation details._
_See: SpecStory history [2023-05-15_fixing-task-022-test-failures](.specstory/history/2023-05-15_fixing-task-022-test-failures.md) for test fixes._
_See: SpecStory history [2025-05-01_15-41-fix-session-test-failures](.specstory/history/2025-05-01_15-41-fix-session-test-failures.md) for task #022 implementation progress._

### Security
- Sanitized external command execution to prevent shell injection

### Added
- Task #022 to address remaining test failures and linting issues after task #002 implementation

## [0.39.0] - 2025-04-29

### Changed
- Clarified that `minsky tasks list --json` should be used to query the backlog.

_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for implementation details._

 