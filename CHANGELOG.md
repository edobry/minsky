# Changelog

All notable changes to the Minsky project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Task #096: Improve CLI Adapter Structure for Shared Options
  - Created a shared options system to reduce code duplication and ensure consistency across CLI commands
  - Added TypeScript interfaces for common option groups (repository resolution, output format, etc.)
  - Implemented functions to add common options to Commander commands
  - Created parameter normalization helpers to standardize CLI option handling
  - Updated task, session, git, rules, and init commands to use the shared options system
  - Improved exports in CLI utilities index.ts to properly handle TypeScript types
  - Implemented consistent pattern for command creation across all CLI adapter files
  - Standardized option descriptions and defaults across the CLI interface
  - Added tests for the shared options module

_See: SpecStory history [2025-05-22_improve-cli-adapter-structure](mdc:.specstory/history/2025-05-22_improve-cli-adapter-structure.md) for implementation details._

- Task #105: Add Session Inspect Subcommand for Current Session Detection

  - Will add a new `inspect` subcommand to the `minsky session` command
  - Will allow users to quickly view current session details with autodetection
  - Will reuse existing `getCurrentSessionContext` utility for session detection
  - Will provide both human-readable and JSON output formats

- Task #099: Implement Environment-Aware Logging
  - Added environment-aware logging system with HUMAN and STRUCTURED modes
  - Implemented automatic detection of terminal environments to set appropriate logging mode
  - Added MINSKY_LOG_MODE environment variable for explicit mode control
  - Added ENABLE_AGENT_LOGS flag to enable JSON logs in HUMAN mode if needed
  - Updated error handling to prevent double-logging
  - Modified CLI adapters to use appropriate logging methods based on mode
  - Created comprehensive documentation in docs/logging.md
  - Added tests for the logging mode detection logic

_See: SpecStory history [2025-05-19_implement-environment-aware-logging](mdc:.specstory/history/2025-05-19_implement-environment-aware-logging.md) for logging implementation._

- Task #052: Add Remaining Task Management Commands to MCP
  - Added the following new task management commands to the MCP server:
    - `tasks.filter`: Enhanced task filtering with advanced options (title, ID, sorting)
    - `tasks.update`: Update a task's details (title, description, status)
    - `tasks.delete`: Delete a task with optional force flag
    - `tasks.info`: Get statistical information about tasks with grouping
  - Updated README-MCP.md with comprehensive documentation for all task commands
  - Added test coverage for the new MCP task commands

_See: SpecStory history [2023-05-17_add-remaining-task-commands-to-mcp](mdc:.specstory/history/2023-05-17_add-remaining-task-commands-to-mcp.md) for task implementation._

- Task #095: Fix git prepare-pr Branch Naming Issues

  - Improved the `git prepare-pr` command to consistently use the git branch name for PR branch naming
  - Ensured PR branch names are always in the format `pr/<current-git-branch-name>` regardless of title parameter
  - Maintained separation between branch naming (from git) and commit messages (from title parameter)
  - Enhanced documentation to clarify PR branch naming behavior

- Task #094: Implement Google Tasks Backend
  - Will implement a Google Tasks backend for the Minsky task management system
  - Will provide integration with Google's task management API
  - Will support authentication with Google OAuth2
  - Will map between Minsky task statuses and Google Tasks
  - Will extend TaskService to support Google Tasks as a backend option

_See: SpecStory history [2025-06-02_add-google-tasks-backend](mdc:.specstory/history/2025-06-02_add-google-tasks-backend.md) for task creation._

- Task #086: Formalized Core Minsky Concepts and Relationships
  - Created comprehensive documentation of core concepts in `src/domain/concepts.md`
  - Added migration guide in `src/domain/migration-guide.md`
  - Updated JSDoc comments in domain files to use consistent terminology
  - Added core concepts overview to README.md
  - Defined clear terminology for Repository, Session, and Workspace
  - Documented URI handling and auto-detection rules

_See: SpecStory history from task #080 for background analysis on workspace and repository concepts._

- Task #093: Implement consistent CLI error handling across all commands
  - Created a centralized error handling utility in `src/adapters/cli/utils/error-handler.ts`
  - Added type-specific error handling for different error categories (validation, resource not found, etc.)
  - Implemented consistent output formatting with the new `outputResult` utility
  - Added debug mode detection to show detailed error information only when needed
  - Refactored session, tasks, git, and init commands to use the centralized error handler
  - Improved user experience by providing clear, concise error messages

_See: SpecStory history [2025-06-18_implement-consistent-cli-error-handling](mdc:.specstory/history/2025-06-18_implement-consistent-cli-error-handling.md) for error handling implementation._

- Task #092: Add session pr command and improve git prepare-pr interface

  - Implemented a new `session pr` command that automatically detects session context
  - Improved the `git prepare-pr` command interface for better consistency with other commands
  - Updated PR preparation workflow documentation to match actual commands available
  - Added clear user feedback and error handling for the new command

- Task #084: Extended auto-detection to additional commands

  - Updated task spec to reflect current command structure
  - Will extend auto-detection for `tasks status set`, `git summary`, and session commands
  - Will use the centralized `getCurrentSessionContext` utility across more commands
  - Will standardize user feedback and error handling for all auto-detecting commands

- Task #025: Added git approve command for session PR merging
  - Added `git approve` command to merge PR branches into the base branch
  - Implemented task metadata storage with merge commit information
  - Added clean exit codes for error conditions (dirty work tree, merge conflicts, etc.)
  - Enhanced GitService with PR branch management functionality
  - Integrated with task metadata to record merge information

_See: SpecStory history [2025-05-18_git-approve-command](.specstory/history/2025-05-18_git-approve-command.md) for git approve command implementation._

- Task #078: Fixed rules CLI to operate on rules in the current workspace (main or session)

- Enhanced PR workflow with "prepared-merge" capabilities:

  - New `git summary` command (renamed from `git pr`) for PR description generation
  - New `git prepare-pr` command to create PR branches with merge commits
  - New `git merge-pr` command to fast-forward merge PR branches
  - New `session approve` command to approve PRs and update task status

- New workspace verification rules to ensure correct file paths and command execution environments.
- Added task context detection and automatic session selection for context-aware commands.
- Improved error handling with detailed error messages and appropriate exit codes.

- Enhanced PR workflow:

  - Modified `git prepare-pr` command to create branches with `pr/` prefix
  - Added new `session pr` command that specifically creates PR branches for sessions
  - Improved branch naming with automatic conversion from titles to valid branch names
  - Added session auto-detection for PR commands when run from session workspaces

- Added tests for Session domain methods: getSessionFromParams, listSessionsFromParams, deleteSessionFromParams, startSessionFromParams, updateSessionFromParams, getSessionDirFromParams
- Added tests for Rules domain methods: listRules, getRule, searchRules, createRule, updateRule
- Added tests for Tasks domain methods: getTaskFromParams, listTasksFromParams, getTaskStatusFromParams, setTaskStatusFromParams
- Added tests for Git domain methods: createPullRequestFromParams, commitChangesFromParams
- Added tests for Workspace domain methods: isSessionRepository, getSessionFromRepo, getCurrentSession, resolveWorkspacePath

### Changed

- Refactored CLI command implementations to use shared option utilities
- Improved error handling with centralized utilities

- Task #089: Aligned CLI Commands with Revised Concepts
  - Updated CLI command options and descriptions to use the new terminology from Task #086
  - Renamed `--workspace` parameter to `--upstream-repo` across all commands
  - Changed "Repository path" to "Repository URI" in command descriptions
  - Updated "main workspace" and "main branch" references to "upstream repository" and "upstream branch"
  - Standardized parameter naming conventions across all CLI commands
  - Updated schemas to reflect the revised concepts terminology
  - Improved default branch detection to work with repositories using non-main default branches

_See: SpecStory history from task #086 for formalization of core concepts._

- Renamed `git pr` command to `git summary` for clearer separation of concerns
- Extended TaskService to store merge metadata in task specifications
- Updated task status to DONE automatically when PRs are merged through session approve
- Improved log messages to provide better context for errors and operations
- Enhanced session management to support PR workflow and preserve task history

- Improved PR logic to always compare against the correct integration branch (remote HEAD, upstream, main, or master)
- PR output now includes both committed and uncommitted (working directory) changes
- README rewritten for clarity and idiomatic open source style
- All debug output is now opt-in and sent to stderr
- Aligned GitHub repository backend implementation with unified interface:
  - Fixed type compatibility between RepositoryStatus and RepoStatus interfaces
  - Standardized method signatures across different backend implementations
  - Improved code reuse by leveraging existing GitService methods
  - Enhanced security by using system Git credentials instead of embedding tokens in URLs
  - Reduced duplication through consistent interface patterns
- Changed default log level from "debug" to "info" to reduce noise in normal operation (Task #081)
  - Debug logs are now only output when LOG_LEVEL is explicitly set to "debug"
  - Documentation updated to clarify how to enable debug logging when needed
- Refactored code to move repo path resolution logic out of `tasks.ts` into a shared utility module
- Updated all `tasks` subcommands to use the shared repo path utility and support `--session` and `--repo` options
- Improved error handling and user feedback for invalid status values in `tasks status set`
- Ensured all code and tests follow best practices for modularity and separation of concerns
- Improved CLI output format by removing timestamps and log level indicators for better user experience
- Updated command-organization rule to reflect the interface-agnostic architecture with domain logic, interface adapters, and command entry points
- **Breaking Change**: Removed the original `git pr` command, replacing it with `git summary` with identical functionality
- Overhauled testing rules system with improved rule organization and relationships:
  - Created testing-router rule as a central entry point for all testing guidance
  - Enhanced testing-boundaries rule with clear guidance on what to test vs. not test
  - Updated bun-test-patterns rule to emphasize required centralized mocking utilities
  - Refactored tests rule to focus on execution requirements and verification protocols
  - Established a clear layered structure for testing rules (Foundation, Implementation, Specialized, Process)
  - Improved descriptions across all testing rules to indicate relationships
  - Added practical examples of correct and incorrect testing patterns
  - Consolidated testing requirements into a clear hierarchical structure
- Enhanced rule-creation-guidelines with new section on cross-rule relationships:
  - Added guidance for creating rule systems with explicit relationships
  - Defined patterns for rule application indicators ("Apply alongside X")
  - Introduced concept of rule layers (Foundation, Implementation, Specialized)
  - Added checklist items for rule cross-referencing
- Fixed rule format and frontmatter issues:
  - Added proper frontmatter to no-dynamic-imports rule and changed extension from .md to .mdc
  - Added proper description to robust-error-handling rule
  - Removed redundant self-improvement-router rule and consolidated router functionality into self-improvement rule
  - Added descriptive frontmatter to template-literals and test-expectations rules

_See: SpecStory history [2025-05-17_add-git-approve-command](mdc:.specstory/history/2025-05-17_add-git-approve-command.md) for implementation details._

- Migrated CLI adapter tests to test domain methods instead of interfaces
- Improved test module isolation using centralized test utilities

_See: SpecStory history [2025-05-17_20-55-migrate-cli-adapter-tests-to-domain-methods](mdc:.specstory/history/2025-05-17_20-55-migrate-cli-adapter-tests-to-domain-methods.md) for test migration work._

### Fixed

- Fixed inconsistent option parsing between command modules

- Fixed test failures in domain module:
  - Fixed `session-approve.test.ts` by implementing proper dependency injection for `getCurrentSession` and flexible parameter types
  - Fixed `git-pr-workflow.test.ts` by using more reliable assertion patterns and better mock creation
  - Fixed `repo-utils.test.ts` by implementing proper tests without modifying readonly properties
  - Fixed `workspace.ts` by adding missing `isSessionRepository` export alias
  - Fixed `workspace.test.ts` by implementing proper dependency injection tests
  - Improved test stability with more flexible dependency injection patterns
  - Removed unnecessary debugging console logs from production code

_See: SpecStory history [2025-06-20_fix-domain-test-failures](mdc:.specstory/history/2025-06-20_fix-domain-test-failures.md) for test fixes._

- Fixed "paths[1]" property error in session start command by improving clone result handling:

  - Enhanced the SessionDB.getRepoPath method to safely handle different result formats
  - Fixed cases where workdir property was accessed incorrectly
  - Added better error handling with clear error messages for debugging
  - Improved the interface between GitService.clone and session management

- Improved error handling in session start command to display cleaner, less verbose error messages

- Fixed `git prepare-pr`
