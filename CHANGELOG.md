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

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._

### Changed
- Improved PR logic to always compare against the correct integration branch (remote HEAD, upstream, main, or master)
- PR output now includes both committed and uncommitted (working directory) changes
- README rewritten for clarity and idiomatic open source style
- All debug output is now opt-in and sent to stderr
- Refactored code to move repo path resolution logic out of `tasks.ts` into a shared utility module
- Updated all `tasks` subcommands to use the shared repo path utility and support `--session` and `--repo` options
- Improved error handling and user feedback for invalid status values in `tasks status set`
- Ensured all code and tests follow best practices for modularity and separation of concerns

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for CLI and organization changes._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._

### Fixed
- Fixed issues with empty stats and file lists in PR output by improving base commit detection and diff logic
- Fixed linter/type errors in session DB and domain modules
- Fixed Markdown parser and status setter to ignore code blocks and only update real tasks
- Fixed test reliability and linter errors in domain logic tests

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for CLI and organization fixes._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command fixes._

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

 