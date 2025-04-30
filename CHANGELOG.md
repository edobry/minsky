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

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._
_See: SpecStory history [2025-04-29_XX-XX-task-004-session-get-task-option](.specstory/history/2025-04-29_XX-XX-task-004-session-get-task-option.md) for implementation details._

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

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._
_See: SpecStory history [2025-04-29_18-50-task-002-per-repo-session-storage](.specstory/history/2025-04-29_18-50-task-002-per-repo-session-storage.md) for task #002 implementation._
_See: SpecStory history [2025-04-30_01-14-task-002-progress-and-updates](.specstory/history/2025-04-30_01-14-task-002-progress-and-updates.md) for sessions subdirectory enhancement._

### Fixed
- Fixed issues with empty stats and file lists in PR output by improving base commit detection and diff logic
- Fixed linter/type errors in session DB and domain modules
- Fixed Markdown parser and status setter to ignore code blocks and only update real tasks
- Fixed test reliability and linter errors in domain logic tests
- Fixed a critical bug in session creation where database operations were in the wrong order, causing "Session not found" errors when trying to start a session with a task ID
- Fixed session path resolution to properly handle both legacy and new directory structures
- Fixed compatibility issues in workspace tests when dealing with session paths

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for CLI and organization fixes._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command fixes._
_See: SpecStory history [2024-02-14_18-30-git-modified-files](.specstory/history/2024-02-14_18-30-git-modified-files.md) for git domain changes._

## [Unreleased]
### Added
- New `tasks` command with `list`, `get`, and `status` (with `get` and `set`) subcommands for task management.
- Support for multiple task backends (Markdown file, placeholder for GitHub Issues).
- Robust Markdown checklist parser for `process/tasks.md` supporting code block skipping, description aggregation, and malformed line filtering.
- Shared `resolveRepoPath` utility in `src/domain/repo-utils.ts` for resolving repo paths from CLI options, session DB, or git context.
- Comprehensive domain-level tests for all `tasks` logic and repo path resolution.

### Changed
- Refactored code to move repo path resolution logic out of `tasks.ts` into a shared utility module.
- Updated all `tasks` subcommands to use the shared repo path utility and support `--session` and `--repo` options.
- Improved error handling and user feedback for invalid status values in `tasks status set`.
- Ensured all code and tests follow best practices for modularity and separation of concerns.

### Fixed
- Fixed Markdown parser and status setter to ignore code blocks and only update real tasks.
- Fixed test reliability and linter errors in domain logic tests.
- Fixed a critical bug in session creation where database operations were in the wrong order, causing "Session not found" errors when trying to start a session with a task ID

### (Previous unreleased entries)
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

### Changed
- Improved PR logic to always compare against the correct integration branch (remote HEAD, upstream, main, or master)
- PR output now includes both committed and uncommitted (working directory) changes
- README rewritten for clarity and idiomatic open source style
- All debug output is now opt-in and sent to stderr

### Fixed
- Fixed issues with empty stats and file lists in PR output by improving base commit detection and diff logic
- Fixed linter/type errors in session DB and domain modules

 