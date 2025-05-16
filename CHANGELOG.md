import { promises as fs } from "fs";
import { join, basename, dirname } from "path";
import * as grayMatterNamespace from "gray-matter";
import { existsSync } from "fs";
import * as jsYaml from "js-yaml";

const matter = (grayMatterNamespace as any).default || grayMatterNamespace;

// Create a custom stringify function that doesn't add unnecessary quotes
function customMatterStringify(content: string, data: any): string {
  // Use js-yaml's dump function directly with options to control quoting behavior
  const yamlStr = jsYaml.dump(data, {
    lineWidth: -1,      // Don't wrap lines
    noCompatMode: true, // Use YAML 1.2
    quotingType: '"',   // Use double quotes when necessary
    forceQuotes: false  // Don't force quotes on all strings
  });
  
  return `---\n${yamlStr}---\n${content}`;
}

# Changelog

> **Note:** This changelog references SpecStory conversation histories. See [.specstory/.what-is-this.md](.specstory/.what-is-this.md) for details on the SpecStory artifact system.

## [Unreleased]

### Fixed

- Fixed incorrect import path in session.ts that was causing "Cannot find module '../utils/workspace.js'" error in `minsky tasks status get` command
- Fixed interactive status selection in `minsky tasks status set` command so it properly prompts for status when not provided as a command-line argument
- Task ID normalization now consistently handles task IDs with or without the `#` prefix. This fixes issues with commands like `minsky tasks get 071` and `minsky session start --task 071` where tasks couldn't be found if the ID was provided without the leading `#`.
- Improved `normalizeTaskId` function to handle multiple leading `#` characters and validate that task IDs contain only numeric characters.
- Fixed `minsky session delete` command to properly remove both the session repository directory and database record. The command now correctly identifies the repository location regardless of directory structure (legacy or with sessions subdirectory) and properly handles errors during database operations, clearly reporting failures rather than falsely reporting success.
- Removed console.error mocking from integration tests to focus on testing behavior rather than implementation details of error reporting, following the new testing-boundaries guidelines.
- Fixed issue with `minsky rules get --format generic` command where requesting a rule in a format it doesn't exist in would return "Rule not found" error instead of finding the rule in its available format. The command now searches in all formats if a rule isn't found in the requested format and provides a clear message when returning a rule in a different format than requested.
- Removed placeholder tests and replaced with actual implementations in domain test files (#072)
- Fixed empty block statement in session.ts (#072)
- Improved test implementations in git and repository modules to avoid placeholder patterns (#072)
- Fixed session merging with main branch to resolve conflicts (#072)
- Fixed import path in session.test.ts from workspace.js to workspace-utils.js (#072)
- Fixed using mock() vs jest.fn() in commit.test.ts to resolve linter errors (#072)
- Added type safety improvements in commit.test.ts to handle potentially undefined objects and fix GitStatus type mismatches (#072)
- Fixed placeholder tests in list.test.ts and get.test.ts with proper implementation notes (#072)
- Added TestSessionParams type to fix type errors in get.test.ts (#072)
- Replaced placeholder tests in git/commit.test.ts, session/commit.test.ts, and session/autoStatusUpdate.test.ts with properly structured tests (#072)
- Fixed missing variable declarations in startSession.test.ts to avoid linter errors (#072)
- Fixed `minsky rules create/update` description quoting bug by replacing gray-matter's default stringify function with a custom implementation that uses js-yaml directly. This ensures that descriptions with special characters use double quotes instead of single quotes, and simple descriptions don't have any quotes at all. (#065)

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
- Created task specification for task #026 to fix task spec paths to use the standardized format.
- Added comprehensive tests for task spec path resolution in `tasks.specpath.test.ts`
- Added new task #027 to auto-detect session context in session commands
- Added `minsky tasks create` command to create new tasks from specification documents. The command extracts the title and description from the spec file, assigns the next available ID, and adds a checklist item to process/tasks.md. It supports session/repo resolution for proper workspace path handling and outputs the task details in either human-readable or JSON format.
- Added `--task <task-id>` option to `minsky git pr` command, allowing users to generate PR descriptions by specifying a task ID rather than a session or path. The command looks up the session associated with the specified task and generates a PR description using that session's repository.
- Added repository backend support with interfaces for different repository implementations:
  - Created `RepositoryBackend` interface with standardized methods for repository operations
  - Implemented `LocalGitBackend` to handle existing local Git repositories
  - Implemented `RemoteGitBackend` for generic remote Git URLs
  - Implemented `GitHubBackend` for GitHub-specific repositories
  - Added consistent return types with `Result` and `RepoStatus` interfaces
  - Added repository configuration through `RepositoryBackendConfig` interface
- Enhanced session commands with repository backend support:
  - Added `--backend` option to specify backend type (local, remote, github)
  - Added automatic backend detection based on repository URL format
  - Added GitHub-specific options for authentication and repository information
  - Improved error handling with type-safe error messages
  - Added backwards compatibility for existing sessions
- Added robust type safety throughout repository implementations:
  - Fixed potential undefined values in parsed command output
  - Added null safety with fallback values
  - Improved error handling with proper error propagation
  - Enhanced interface consistency across all backend implementations
- Added `git commit` command for staging and committing changes in a single step, with support for automatic staging (can be disabled with `--no-stage`), staging all changes (via `--all`), task ID prefixing for commit messages, and amending commits (via `--amend`). Supports specifying a session or repository path.
- Project tooling and automation setup (ESLint, Prettier, Husky, lint-staged)
- Continuous Integration workflow with GitHub Actions
- Development environment configuration (VS Code settings, Docker)
- Dependabot for automated dependency updates
- Development quickstart guide in README.md
- Enhanced ESLint configuration with rules for:
  - Domain-oriented module structure enforcement
  - Constants management and magic numbers prevention
  - Robust error handling practices
  - File size limitations
  - Ensuring Bun is used instead of npm/node
- Added pre-push Git hook to ensure tests pass before pushing changes
- Created future task specifications for session-first workflow verification and changelog management automation
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
- New `test-helpers.ts` utility module with reusable functions for test isolation, environment setup, and error handling
- Standardized test environment management with consistent resource cleanup
- Type-safe test helper functions for subprocess execution and error handling
- Added Session Cleanup Procedures section to the minsky-workflow rule, providing clear guidelines for properly cleaning up completed tasks and sessions using the Minsky CLI commands rather than manual file operations
- Automated task status updates at key workflow points:
  - The `session start` command now automatically sets task status to IN-PROGRESS when started with `--task`
  - The `git pr` command now automatically sets task status to IN-REVIEW when generating a PR
  - Both commands support a `--no-status-update` flag to skip the automatic update
  - Both commands show feedback about the status update operation
  - Task ID is intelligently resolved from options, session metadata, or branch name
- Enhanced `tasks status set` command to interactively prompt for status when not provided as an argument. If run in a non-interactive environment without a status, the command now fails gracefully with a clear error message. The prompt uses @clack/prompts to present a list of valid statuses to choose from and allows cancellation. The improvement increases usability by reducing friction for setting task statuses.
- Task: Add Session Information to Task Details [#043](process/tasks/043-add-session-information-to-task-details.md)
- New `test-infrastructure-patterns` cursor rule capturing best practices for test isolation, environment setup, and CLI testing from our test fixes work. The rule includes patterns for creating unique test directories, standardizing environment setup, properly mocking dependencies, and debugging test failures.
- Enhanced task #014 (Add Repository Backend Support) to specifically focus on supporting remote Git repositories as repository backends. This includes a generic Remote Git backend for any remote Git URL, as well as a specific GitHub backend implementation. The task now more clearly defines the requirements for ensuring session workflows can use remote repositories as their origin.
- Created task #051 to add Git command support to the MCP server, enabling AI assistants to perform Git operations via the Model Context Protocol
- Created task #052 to add remaining task management commands to the MCP server, completing the task management API for AI assistants
- Detailed implementation plan for task #039: Interface-Agnostic Command Architecture, which will refactor the command architecture to enable direct function calls across different interfaces (CLI, MCP, and potentially others like REST APIs in the future)
- Added safety check to the `session start` command to prevent creating sessions from within existing session workspaces, displaying a clear error message instructing users to return to the main workspace first
- Created test-utils module with standard test setup, cleanup, and utility functions:
  - Fixed timestamp management to eliminate flaky tests
  - Centralized console output spying
  - Added temporary directory management for file system tests
  - Standardized environment setup and teardown
- Created standardized test fixtures directory with common test data
- Added `rules` command for managing Minsky rules with YAML frontmatter
  - Added `rules list` subcommand to list all rules in a repository
  - Added `rules get` subcommand to view specific rule content and metadata
  - Added `rules update` subcommand to update rule content or metadata
  - Added `rules create` subcommand to create new rules (with interactive mode)
  - Added `rules search` subcommand to search for rules by content or metadata
  - All commands support filtering by rule format (cursor or generic)
  - Added JSON output option for machine-readable results
  - Support for tag-based filtering and advanced metadata handling
  - Comprehensive domain-level tests for all rule management logic
- New AI rules to support rule management:
  - Added `rules-management.mdc` rule documenting how to use the rules command
  - Updated `rule-creation-guidelines.mdc` with information about using the rules command
  - Updated `minsky-workflow.mdc` to include guidelines for managing AI rules
  - Updated `index.mdc` to reference the new rules-management rule
- Enhanced `minsky init` command with MCP (Model Context Protocol) server configuration options:
  - Automatically generates `.cursor/mcp.json` configuration file during project initialization
  - Added new CLI options to customize MCP setup: `--mcp`, `--mcp-transport`, `--mcp-port`, `--mcp-host`
  - Added interactive prompts for MCP configuration when options are not provided
  - Implemented support for all MCP transport types: stdio (default), SSE, and HTTP streaming
  - Created comprehensive MCP usage rule (`mcp-usage.mdc`) with detailed documentation on connecting to and using the MCP server
  - Added tests for MCP configuration generation and CLI options
  - Added `--mcp-only` option to configure MCP in existing projects without reinitializing other files
  - Added `--overwrite` option to update existing configuration files
- Repository backend support for session operations with different Git repository sources
- Interface for repository backend operations (clone, branch, PR)
- Local file system implementation for repository backend
- GitHub API integration for repository backend
- Remote Git repository support for repository backend
- Full error handling and retry logic for Git operations
- Implemented interface-agnostic command architecture for task #039, enabling direct function calls across different interfaces (CLI, MCP, and others):
  - Extracted pure domain functions for tasks, session, and git commands with TypeScript interfaces
  - Added Zod schemas for parameter validation and consistent error handling
  - Created adapter layers for CLI and MCP interfaces using the same domain functions
  - Converted task commands from CommonJS to ESM syntax for better module compatibility
  - Added createTaskFromParams domain function to complete the task command set
  - All functions follow consistent interface patterns with dependency injection for testing
  - Merged latest changes from main branch and resolved conflicts in git.ts
- Single-line description validation to interactive mode of `minsky rules create` command to ensure rule descriptions don't contain newlines
- Shared validation utility `validateSingleLineDescription` in `src/domain/validationUtils.ts` and refactored `minsky rules create` to use it.
- New AI guideline rule (`.cursor/rules/ai-linter-autofix-guideline.mdc`) to instruct AI not to over-optimize linter-autofixable formatting, relying on linters instead.
- Updated testing-boundaries rule with clear guidelines on what should and should not be tested, particularly regarding CLI interactive features and implementation details.
- New `minsky rules sync` command to synchronize rule files between main workspace and session workspaces
- Debug mode for rules commands to help troubleshoot rule loading issues
- Documentation in `.cursor/rules/README.md` explaining workspace isolation and rule management
- Centralized test mock utilities in `src/utils/test-utils/mocking.ts` with functions like `createMock`, `mockModule`, `setupTestMocks`, `createMockObject`, `createMockExecSync`, and `createMockFileSystem` that encapsulate correct bun:test mocking patterns. These utilities improve test reliability, maintainability, and consistency across the codebase.
- Comprehensive test suite for the mocking utilities in `src/utils/test-utils/mocking.test.ts` that verifies all functionality and provides usage examples.
- Implemented structured logging system using Winston for consistent, configurable logging across the codebase:
  - Created centralized `src/utils/logger.js` module with separate loggers for agent events (structured JSON to stdout) and program messages (human-readable text to stderr)
  - Added support for different log levels (debug, info, warn, error) configurable via environment variables
  - Implemented proper error handling with stack traces and context preservation
  - Migrated all console.log/error/warn calls to use the structured logging system
  - Added context objects to error logs for better debugging
  - Standardized output formats for both human and machine consumption
  - Created LogCapture utility for testing code that uses the logger

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._
_See: SpecStory history [2025-04-29_XX-XX-task-004-session-get-task-option](.specstory/history/2025-04-29_XX-XX-task-004-session-get-task-option.md) for implementation details._
_See: SpecStory history [task-id-format-support-specification](.specstory/history/task-id-format-support-specification.md) for task creation._
_See: SpecStory history [2025-05-02_large-file-analysis](.specstory/history/2025-05-02_large-file-analysis.md) for codebase analysis and task creation._
_See: SpecStory history [2025-05-XX_XX-XX-task-006-quiet-option](.specstory/history/2025-05-XX_XX-XX-task-006-quiet-option.md) for session start command --quiet option implementation._
_See: SpecStory history [2023-XX-XX_XX-XX-task-014-add-repository-backend-support](.specstory/history/2023-XX-XX_XX-XX-task-014-add-repository-backend-support.md) for repository backend implementation._
_See: SpecStory history [2024-05-09_create-task-add-session-info-to-task-details](.specstory/history/2024-05-09_create-task-add-session-info-to-task-details.md) for task creation._
_See: SpecStory history [2023-05-15_fixing-task-022-test-failures](.specstory/history/2023-05-15_fixing-task-022-test-failures.md) for test infrastructure patterns._
_See: SpecStory history [2024-05-16_remote-repository-support](.specstory/history/2024-05-16_remote-repository-support.md) for updated task requirements._
_See: SpecStory history [2024-05-16_mcp-commands-enhancement](.specstory/history/2024-05-16_mcp-commands-enhancement.md) for MCP command tasks._
_See: SpecStory history [2025-05-10_implementation-of-rules-command](.specstory/history/2025-05-10_implementation-of-rules-command.md) for task#029 implementation._
_See: SpecStory history [2025-05-14_interface-agnostic-command-architecture](.specstory/history/2025-05-14_interface-agnostic-command-architecture.md) for task#039 implementation._
_See: Task Specification [068-ai-guideline-do-not-over-optimize-indentation](process/tasks/068-ai-guideline-do-not-over-optimize-indentation.md) for the AI linter autofix guideline rule (originally indentation, now generalized)._
_See: SpecStory history [2025-05-14_task-071-remove-interactive-cli-tests](.specstory/history/2025-05-14_task-071-remove-interactive-cli-tests.md) for task#071 implementation._
_See: SpecStory history [2024-07-17_task-059-add-centralized-test-mock-utilities](.specstory/history/2024-07-17_task-059-add-centralized-test-mock-utilities.md) for task#059 implementation of centralized test mock utilities._

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
- Enhanced ESLint configuration with additional rules to enforce project-specific coding standards and practices
- Support for HTTPS and SSH git URL normalization in `normalizeRepoName` to produce consistent paths
- Enhanced URL handling to preserve domain names for github.com repositories
- Improved session directory path handling with support for backward compatibility
- Updated implementation to handle both legacy and new session path formats (with "sessions" subdirectory)
- Fixed session lookup by task ID in `session get` and `session dir` commands
- Standardized code style to use double quotes instead of single quotes
- Normalize task IDs consistently by ensuring the '#' prefix is added if missing
- Changed SessionDB.getNewSessionRepoPath to return a string instead of a Promise
- Enhanced task creation workflow to support both title formats: `# Task: Title` (without a task number) and `# Task #XXX: Title` (with a task number). The CLI now automatically assigns the next available task number when no number is provided, updates the title in the file, and renames the file to match the assigned number and title.
- Improved session test files (list.test.ts, startSession.test.ts) with better isolation and error handling
- Updated tasks list test with better subprocess error checking
- Removed Jest-specific code that doesn't work in Bun's test environment
- Added proper error checking for subprocess execution in tests
- Updated PR test to use the new test utilities
- Improved test assertion precision with more specific matchers
- Standardized test environment setup and teardown
- Refactored `prWithDependencies` method in `GitService` into smaller, focused functions:
  - Extracted commit formatting logic into `formatCommits` method
  - Extracted PR markdown generation into `buildPrMarkdown` method
  - Split repository data collection into multiple specialized methods:
    - `getCommitsOnBranch`
    - `getModifiedFiles`
    - `getWorkingDirectoryChanges`
    - `getChangeStats`
  - Improved error handling in all extracted methods
  - Reduced cognitive complexity while maintaining full test coverage
- Generalized the AI indentation guideline to cover all linter-autofixable formatting issues. Renamed rule file from `ai-indentation-guideline.mdc` to `ai-linter-autofix-guideline.mdc` and ensured correct location in `.cursor/rules/`.
- Updated `lint-staged` configuration (`.lintstagedrc.json`) to allow commits even if `eslint --fix` has non-autofixable errors. Autofixes are applied, but the commit is not blocked. Documented this behavior in `README.md`.
- Removed incorrect "bug note" from task-status-verification rule
- Improved error handling and diagnostics in rule loading

_See: SpecStory history [2025-04-26_20-30-setting-up-minsky-cli-with-bun](.specstory/history/2025-04-26_20-30-setting-up-minsky-cli-with-bun.md) for project setup, CLI, and domain/command organization._
_See: SpecStory history [2025-04-26_22-29-task-management-command-design](.specstory/history/2025-04-26_22-29-task-management-command-design.md) for task management and tasks command._
_See: SpecStory history [2025-04-27_21-26-add-task-statuses-in-progress-and-in-review](.specstory/history/2025-04-27_21-26-add-task-statuses-in-progress-and-in-review.md) for details on status additions._
_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for task ID support in session start command._
_See: SpecStory history [2025-04-29_18-50-task-002-per-repo-session-storage](.specstory/history/2025-04-29_18-50-task-002-per-repo-session-storage.md) for task #002 implementation._
_See: SpecStory history [2025-04-30_01-14-task-002-progress-and-updates](.specstory/history/2025-04-30_01-14-task-002-progress-and-updates.md) for sessions subdirectory enhancement._
_See: SpecStory history [2025-04-29_18-53-starting-task-002.md](.specstory/history/2025-04-29_18-53-starting-task-002.md) for task #002 implementation._
_See: SpecStory history [2025-04-30_17-43-task-002-progress-and-updates.md](.specstory/history/2025-04-30_17-43-task-002-progress-and-updates.md) for task #002 completion._
_See: SpecStory history [2025-05-01_15-41-fix-session-test-failures](.specstory/history/2025-05-01_15-41-fix-session-test-failures.md) for task #022 implementation._
_See: SpecStory history [2025-05-08_test-fixes](.specstory/history/2025-05-08_test-fixes.md) for test fixes implementation._
_See: SpecStory history [2023-05-06_13-13-fix-session-test-failures](.specstory/history/2023-05-06_13-13-fix-session-test-failures.md) for task 022 implementation._
_See: SpecStory history [2024-02-14_18-30-git-modified-files](.specstory/history/2024-02-14_18-30-git-modified-files.md) for git domain changes._
_See: SpecStory history [002-per-repo-session-storage.md](process/tasks/002-per-repo-session-storage.md) for implementation details._
_See: SpecStory history [2025-05-XX_XX-XX-task-026-fix-task-spec-paths](.specstory/history/2025-05-XX_XX-XX-task-026-fix-task-spec-paths.md) for task #026 implementation details._
_See: SpecStory history [2025-05-01_17-04-task-026-fix-task-spec-paths](.specstory/history/2025-05-01_17-04-task-026-fix-task-spec-paths.md) for task spec path standardization._
_See: SpecStory history [2025-05-04_20-14-task-022-progress-and-specifications.md](.specstory/history/2025-05-04_20-14-task-022-progress-and-specifications.md) for backend test fixes._
_See: SpecStory history [2025-05-22_task-021-refactor-git-service](.specstory/history/2025-05-22_task-021-refactor-git-service.md) for implementation details._
_See: SpecStory history [2024-07-01_rule-sync-bug-diagnostics](.specstory/history/2024-07-01_rule-sync-bug-diagnostics.md) for rule sync bug investigation._

### Added

- Completed interface-agnostic architecture migration (Task #076)
  - All command modules now use the new adapter implementations
  - Removed all old implementation files from src/commands
  - All domain tests are passing with the new architecture
  - Each domain module now has a clean interface-agnostic function API with Zod schema validation
- Interface-agnostic architecture implementation with domain functions and adapters
- CLI adapters for session commands
- CLI adapters for rules commands
- CLI adapters for git commands with push functionality
- CLI adapters for init command
- Zod schemas for command parameters to ensure type safety
- Architecture documentation in README

### Changed

- Refactored CLI entry point to use new adapters
- Improved error handling in adapters with better error messages
- Updated task specification and worklog

## [0.39.0] - 2025-04-29

### Changed

- Clarified that `minsky tasks list --json` should be used to query the backlog.

_See: SpecStory history [2025-04-28_16-22-backlog-task-inquiry](.specstory/history/2025-04-28_16-22-backlog-task-inquiry.md) for implementation details._

### Fixed

- Fixed import paths in src/cli.ts to use relative paths (./commands/session) instead of absolute paths (./src/commands/session)
- Added missing command imports in src/cli.ts (tasks, git, and init commands)
- Fixed test failures in session command tests by correcting import paths
- Improved test structure and reliability for Minsky CLI tests:
  - Created a comprehensive test helper module with utilities for test isolation, setup, and teardown
  - Fixed test-related import paths to use `.ts` extension instead of `.js`
  - Added detailed debug logging to diagnose test failures
  - Improved session database initialization in tests
  - Enhanced test fixture creation with proper Minsky workspace structure
  - Fixed environment variable handling for XDG_STATE_HOME in tests
  - Improved error reporting in tests to make failures more actionable
  - Updated test assertions to be more resilient to minor output differences
  - Fixed several tests to use individual test directories to prevent interference
  - Added proper cleanup between tests to ensure test isolation
- Fixed merge conflicts in several test files for task #044
  - Resolved conflicts in get.test.ts, session commands tests, and gitServiceTaskStatusUpdate.test.ts
  - Improved file system path handling in session directory tests
  - Enhanced setupSessionDb functions across session command tests to handle file creation edge cases
  - Fixed workspace validation in tasks/list.test.ts by correctly setting up required Minsky project structure
  - Improved error handling and debug logging for test failures
  - Created more robust helper functions for test setup and cleanup
- Fixed import extensions in test files to use .ts instead of .js
  - Updated imports in cd.test.ts and gitServiceTaskStatusUpdate.test.ts
  - Consistently used double quotes for string literals
  - Fixed environment variable handling in session tests
- Enhanced session test error handling and logging:
  - Added detailed verification of directory and file creation
  - Improved error messages for file system operations
  - Added robust error handling with try/catch blocks around file operations
  - Added parent directory creation checks before file write operations
- Fixed workspace validation in tasks/list.test.ts:
  - Added proper package.json and git config files to pass validation
  - Created filter-messages.ts utility for proper message handling
  - Added verification steps to confirm directories and files are created
  - Fixed assertions to match actual command output format

_See: SpecStory history [2023-05-06_13-13-fix-session-test-failures](.specstory/history/2023-05-06_13-13-fix-session-test-failures.md) for task 022 implementation._

## [Unreleased]

### Fixed

- Fixed test failures in Minsky CLI test suite by improving setupSessionDb functions and workspace validation
- Fixed issues with session-related tests by enhancing error handling and directory creation
- Fixed task list tests by ensuring tasks.md is created in the proper process directory
- Added more robust directory existence checking and file creation in test setup
- Fixed skipped tests in session/delete.test.ts by implementing proper task ID support in the mock helper
- Updated mock CLI command implementations to handle task ID operations consistently
- Ensured proper type safety in test mocks
- Restored missing tests for the `init` command with a simplified approach to avoid mock.fn incompatibilities

### Changed

- Improved test environment setup to create more complete Minsky workspace structure
- Enhanced error handling and debugging output in test environment setup

## [0.52.0] - 2024-04-09

### Fixed

- Task ID normalization now consistently handles task IDs with or without the `#` prefix. This fixes issues with commands like `minsky tasks get 071` and `minsky session start --task 071` where tasks couldn't be found if the ID was provided without the leading `#`.
- Improved `normalizeTaskId` function to handle multiple leading `#` characters and validate that task IDs contain only numeric characters.
- Task creation handles spec file with missing type
- Improved test environment setup to create more complete Minsky workspace structure
- Enhanced error handling and debugging output in test environment setup

## [Unreleased]

### Changed
- Continued work on interface-agnostic architecture migration (Task #076)
  - All adapter implementations (tasks, git, session, init, rules) are complete
  - CLI has been updated to use the new adapters
  - Domain function tests are passing for the new architecture
  - Old implementation files still need to be removed after all tests pass

_See: SpecStory history [2025-05-16_01-20-structured-logging-implementation](.specstory/history/2025-05-16_01-20-structured-logging-implementation.md) for structured logging implementation._
