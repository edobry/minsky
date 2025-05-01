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
- Created task specification for task #018 to add a `--task <task-id>` option to the `minsky session dir` command, allowing users to look up session directories by their associated task ID
- Created task specification for task #023 to add a task specification path to the task object, which will be displayed by commands that show task details, making it easier to locate and access the full task specification document
- Added task specification path to the task object, which is displayed by the `tasks get` command in both standard and JSON output formats. This makes it easier to locate and access the full task specification document.
- Created task specification for task #024 to fix the `session dir` command logic
- New task for refactoring large methods in GitService, focusing on `prWithDependencies` method (#021)
- Added `--quiet` option to `session start` command that outputs only the session directory path, making it suitable for programmatic use in scripts and automated workflows. When the option is specified, all informational messages are suppressed, and only the essential path is returned.
- Created task specification for task #025 to add a `git approve` command that complements the existing `git pr` command, implementing a prepared-merge workflow for PR review and merging. This workflow allows reviewers to easily merge prepared PRs via fast-forward, ensuring history linearity and cleaner integration.
- Added `--task <task-id>` option to `minsky session dir` command, allowing users to look up session directories by associated task ID. The command now supports both session name and task ID (but not both simultaneously), and provides descriptive error messages for all scenarios.
- Added new task #027 to auto-detect session context in session commands
- Added `--task <task-id>` option to `minsky git pr` command, allowing users to generate PR descriptions by specifying a task ID rather than a session or path. The command looks up the session associated with the specified task and generates a PR description using that session's repository.

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._
_See: SpecStory history [2025-04-29_XX-XX-task-004-session-get-task-option](.specstory/history/2025-04-29_XX-XX-task-004-session-get-task-option.md) for implementation details._
_See: SpecStory history [task-id-format-support-specification](.specstory/history/task-id-format-support-specification.md) for task creation._
_See: SpecStory history [2025-05-02_large-file-analysis](.specstory/history/2025-05-02_large-file-analysis.md) for codebase analysis and task creation._
_See: SpecStory history [2025-05-XX_XX-XX-task-006-quiet-option](.specstory/history/2025-05-XX_XX-XX-task-006-quiet-option.md) for session start command --quiet option implementation._

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
- Fixed task spec path generation to use standardized format (process/tasks/<id>-<kebab-case-title>.md) and added validation to verify file existence. If the exact file doesn't exist, Minsky will look for any file with the matching task ID prefix.

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._
_See: SpecStory history [2025-04-29_18-50-task-002-per-repo-session-storage](.specstory/history/2025-04-29_18-50-task-002-per-repo-session-storage.md) for task #002 implementation._
_See: SpecStory history [2025-04-30_01-14-task-002-progress-and-updates](.specstory/history/2025-04-30_01-14-task-002-progress-and-updates.md) for sessions subdirectory enhancement._
_See: SpecStory history [2025-04-29_18-53-starting-task-002.md](.specstory/history/2025-04-29_18-53-starting-task-002.md) for task #002 implementation._
_See: SpecStory history [2025-04-30_17-43-task-002-progress-and-updates.md](.specstory/history/2025-04-30_17-43-task-002-progress-and-updates.md) for task #002 completion._

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

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for CLI and organization fixes._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command fixes._
_See: SpecStory history [2024-02-14_18-30-git-modified-files](.specstory/history/2024-02-14_18-30-git-modified-files.md) for git domain changes._
_See: SpecStory history [002-per-repo-session-storage.md](process/tasks/002-per-repo-session-storage.md) for implementation details._

### Security
- Sanitized external command execution to prevent shell injection

### Added
- Task #022 to address remaining test failures and linting issues after task #002 implementation

 