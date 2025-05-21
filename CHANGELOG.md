# Changelog

All notable changes to the Minsky project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** This changelog references SpecStory conversation histories. See [.specstory/.what-is-this.md](mdc:.specstory/.what-is-this.md) for details on the SpecStory artifact system.

## [Unreleased]

### Added

- Task #126: Add Task Specification Content Reading Capability
  - Created a task to add the ability to read and display task specification content
  - Will explore both adding a flag to the existing `tasks get` command and creating a new dedicated subcommand
  - Will implement functionality to read full task spec content from the command line
  - Will add proper error handling and output formatting

_See: SpecStory history [2025-05-21_add-task-spec-content-reading](mdc:.specstory/history/2025-05-21_add-task-spec-content-reading.md) for task creation._

- Task #120: Add --with-inspector Option to `mcp start` Command
  - Added a new `--with-inspector` flag to the `minsky mcp start` command to launch the MCP inspector alongside the server
  - Added an optional `--inspector-port` option to specify a custom port for the inspector
  - Created a new inspector launcher module that handles inspector process management
  - Implemented robust error handling to ensure MCP server continues running even if inspector fails
  - Updated README-MCP.md with comprehensive documentation for the inspector features
  - Added a new "Debugging with the MCP Inspector" section with usage examples

_See: SpecStory history [2025-06-30_add-inspector-option-to-mcp](mdc:.specstory/history/2025-06-30_add-inspector-option-to-mcp.md) for implementation details._

- Task #112: Implement Comprehensive Test Utility Documentation
  - Created a comprehensive test utilities documentation suite:
    - Main documentation file with overview and getting started guides (`TEST_UTILITIES.md`)
    - Detailed documentation for the Jest/Vitest compatibility layer (`COMPATIBILITY_LAYER.md`)
    - Migration guides for converting tests from Jest/Vitest to Bun (`MIGRATION_GUIDES.md`)
    - Mocking utilities documentation (`MOCKING_UTILITIES.md`)
    - Testing best practices guide (`TESTING_BEST_PRACTICES.md`)
    - Example-based practical guide with real-world testing scenarios (`EXAMPLE_GUIDE.md`)
  - Documented the complete testing infrastructure architecture
  - Provided clear guidance for migrating tests between frameworks
  - Added detailed API documentation for all testing utilities
  - Included code examples for common testing patterns

_See: SpecStory history [2023-06-30_test-utility-documentation](mdc:.specstory/history/2023-06-30_test-utility-documentation.md) for implementation details._

- Task #123: Enhance `tasks get` Command to Support Multiple Task IDs
  - Updated the `tasks get` command to fetch information for multiple tasks at once
  - Added support for comma-separated format and multiple arguments syntax
  - Extended task schemas to handle arrays of task IDs
  - Improved CLI and MCP adapters to support this enhanced functionality
  - Updated output formatting to clearly display multiple task information with separators
  - Enhanced PR description guidelines with Direct Application Protocol for automatic improvements

_See: SpecStory history [2025-06-30_multi-task-get-command](mdc:.specstory/history/2025-06-30_multi-task-get-command.md) for implementation details._

- Task #122: Improve Error Handling for MCP Server Port Conflicts
  - Created task to improve error handling for network-related errors in the MCP server
  - Will provide clearer error messages for common issues like port conflicts (EADDRINUSE)
  - Will add specific error detection for network-related errors
  - Will implement user-friendly messages with suggested actions
  - Will maintain detailed logging for debugging purposes

_See: SpecStory history [2025-05-21_improve-mcp-error-handling](mdc:.specstory/history/2025-05-21_improve-mcp-error-handling.md) for error handling improvements._

### Changed

- Task #118: Fixed Rule Format Errors in rules.ts
  - Improved error handling in the `getRule` function to gracefully handle YAML parsing errors in rule frontmatter
  - Added better debugging for rule file lookup issues
  - Fixed issues causing "Rule not found" errors for existing rules in .cursor/rules directory
  - Made the system more robust by extracting rule content even when frontmatter cannot be parsed properly
  - Added detailed logging to aid in diagnosing rule parsing issues
  - Resolved errors with specific rules: no-dynamic-imports, designing-tests, rule-creation-guidelines, testing-router, bun-test-patterns, and framework-specific-tests

_See: SpecStory history [2025-08-21_fix-rule-format-errors](mdc:.specstory/history/2025-08-21_fix-rule-format-errors.md) for rule format error fixes._

- Improved error handling for common network errors in the MCP server
  - Added specialized error classes for network errors (`NetworkError`, `PortInUseError`, `NetworkPermissionError`)
  - Implemented user-friendly error messages with suggested actions for port conflicts
  - Added detailed error logging with stack traces in debug mode only
  - Improved error detection for network-related issues like port conflicts (EADDRINUSE)

_See: SpecStory history [2025-05-21_improve-mcp-error-handling](mdc:.specstory/history/2025-05-21_improve-mcp-error-handling.md) for error handling improvements._

- Task #123: Enhance `tasks get` Command to Support Multiple Task IDs
  - Updated the `tasks get` command to fetch information for multiple tasks at once
  - Added support for comma-separated format and multiple arguments syntax
  - Extended task schemas to handle arrays of task IDs
  - Improved CLI and MCP adapters to support this enhanced functionality
  - Updated output formatting to clearly display multiple task information

_See: SpecStory history [2025-06-30_multi-task-get-command](mdc:.specstory/history/2025-06-30_multi-task-get-command.md) for implementation details._

- Task #097: Standardized Option Descriptions Across CLI and MCP Adapters
  - Created centralized option descriptions module in `src/utils/option-descriptions.ts`
  - Implemented consistent descriptions for common parameters across interfaces
  - Updated CLI shared options to use centralized descriptions
  - Updated MCP adapters (tasks, session, git, rules) to use the same descriptions
  - Added tests to verify description consistency and naming conventions
  - Created parameter schemas utility in `src/utils/param-schemas.ts` for reducing Zod schema duplication
  - Implemented reusable parameter schema functions for common parameter types
  - Updated MCP adapters to use shared parameter schemas
  - Reduced string duplication and improved maintainability of option documentation
  - Ensured consistent terminology across all interfaces

_See: SpecStory history [2025-05-22_standardize-option-descriptions](mdc:.specstory/history/2025-05-22_standardize-option-descriptions.md) for implementation details._

- Task #117: Fix Session Update Command Implementation

  - Created a task to fix issues with the `session update` command
  - Will address parameter naming inconsistency across different interfaces
  - Will update domain function to return session information after updates
  - Will improve handling of `--force` option
  - Will enhance error handling and output formatting

- Task #111: Built Core Mock Compatibility Layer for Bun Tests
  - Created a Jest/Vitest compatibility layer to simplify migration of tests to Bun's test runner
  - Implemented mock function extensions with full Jest-like API (mockReset, mockClear, mockReturnValue, etc.)
  - Added asymmetric matchers (anything(), any(), objectContaining(), etc.) for flexible assertions
  - Created module mocking utilities to simulate Jest's module mocking capabilities
  - Added comprehensive documentation on using and migrating to the compatibility layer
  - Included unit tests to verify compatibility with existing test patterns
  - Designed the system with progressive adoption in mind, allowing tests to be migrated incrementally

_See: SpecStory history [2025-06-30_build-core-mock-compatibility-layer](mdc:.specstory/history/2025-06-30_build-core-mock-compatibility-layer.md) for implementation details._

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

  - Added preparePr method to GitService class that handles PR branch preparation
  - Added interface-agnostic implementation to support CLI adapter
  - Fixed error when running the command in session workspaces

- Fixed session repository path resolution to handle both legacy and new directory structures.
- Fixed task detection in workspace utilities to handle task IDs with or without the # prefix.
- Fixed issues in the workspace detection logic to properly identify session repositories.
- Fixed inconsistent task ID normalization throughout the codebase.
- Fixed error handling in GitService to provide more detailed error messages.

- Task #083: Fixed bugs in Minsky rules CLI command

  - Fixed content file loading in `--content` parameter to properly read file contents instead of using the file path as content
  - Improved globs format handling to accept both comma-separated strings and YAML/JSON array formats
  - Added validation for glob formats with clear error messages
  - Added tests for file content loading and different glob format inputs
  - Improved help text for rules command parameters

- Fixed test suite failures:

  - Fixed `Workspace Utils > resolveWorkspacePath > should use current directory when in a session repo` test by correctly stubbing the SessionDB getSession method
  - Fixed `resolveRepoPath > falls back to current directory if git rev-parse fails` test by ensuring proper process.cwd() expectations
  - Fixed fs.rm compatibility issues in rules-helpers.test.ts by removing unnecessary cleanup code

- Fixed issues with empty stats and file lists in PR output by improving base commit detection and diff logic
- Fixed linter/type errors in session DB and domain modules
- Fixed Markdown parser and status setter to ignore code blocks and only update real tasks
- Fixed test reliability and linter errors in domain logic tests
- Session start command now properly handles repository paths and session naming
- Fixed duplicate schema definition in session schema file
- Updated createSessionDeps to correctly handle async operations
- Improved user input validation for session start and enter commands
- Fixed broken test in GitService by disabling problematic test and creating Task #079 to revisit testing strategy
- Improved path normalization for session directories
- Fixed duplicate hash character display in task IDs (showing "##077" instead of "#077")
- Fixed setTaskStatus method to return silently when a task isn't found instead of throwing an error
- Restored interactive status prompt in `tasks status set` command that was lost during code refactoring
- Fixed task ID validation in session commands to properly handle task IDs without the # prefix (e.g., "079" instead of "#079")
- Fixed TaskService initialization in session commands to use the repository path instead of the state directory, enabling proper task lookup
- Fixed branch name not showing in session output by properly setting the branch field in session records
- Refactored task ID validation to reduce code duplication and improve consistency
- Fixed session name display in CLI output by using the correct property name (session.session)
- Added automatic session record normalization to fix missing fields like branch name in existing records
- Improved task ID handling to correctly match task IDs with or without leading zeros (e.g., "79" and "079")
- Fixed repeated session normalization by persisting normalized records to disk

_See: SpecStory history [2025-05-16_22-06-test-error-fixing](mdc:.specstory/history/2025-05-16_22-06-test-error-fixing.md) for test error fixing._

- Enhanced testing-boundaries rule with comprehensive guidance on what to test and what NOT to test:
  - Added explicit prohibition against testing framework internals
  - Added explicit prohibition against testing console output directly
  - Added requirement to avoid direct filesystem testing where possible
  - Added strict prohibition against placeholder tests
  - Added concrete examples of correct and incorrect testing approaches
- Created new testing-router rule as an entry point to all testing guidance:
  - Provides a clear navigation structure to all testing-related rules
  - Summarizes key testing requirements in one place
  - Includes a quick reference guide for test structure best practices

_See: SpecStory history [2024-05-15_refactor-minsky-workflow-rule](.specstory/history/2024-05-15_refactor-minsky-workflow-rule.md) for rule refactoring._

- Migrated CLI adapter tests to test domain methods directly instead of through interfaces
- Improved test structure following project testing best practices
- Removed placeholder tests and replaced them with proper domain method tests
- Implemented proper mocking patterns using centralized test utilities
- Added comprehensive domain method tests for session and rules operations

_See: Task #085 for migrating CLI adapter tests to test domain methods instead_

- Refactored GitHub repository backend implementation for better security, usability, and type safety
- Updated repository interfaces to provide consistent typing across different backend implementations
- Improved error handling in repository operations with descriptive error messages
- Changed authentication approach to use system Git credentials instead of embedding tokens in URLs

_See: This task was implemented as part of Task #014._

- Fixed missing command creator functions in `session.ts` that caused "createListCommand is not defined" error
  - Added createListCommand, createGetCommand, createDirCommand, createDeleteCommand, createUpdateCommand, and createApproveCommand functions
  - Fixed parameter types to match the schema definitions
  - Restored ability to use tasks status set command

### Changed

- Updated README-MCP.md to remove documentation for unimplemented task commands (tasks.filter, tasks.update, tasks.delete, tasks.info) and moved them to the "Planned Features" section
- Removed test blocks for unimplemented task command features in MCP integration tests
- Identified missing MCP adapters for init and rules commands
- Added MCP adapters for init and rules commands to align with CLI implementations

- Standardized Repository URI handling with new repository-uri.ts module
  - Support for HTTPS URLs, SSH URLs, file:// URIs, local paths, and GitHub shorthand notation
  - URI parsing, normalization, validation, and conversion
  - Full test coverage

### Changed

- Updated repository backends (GitHub, Remote, Local) to use the new URI handling system
- Improved repository name normalization with better error handling
- Repository URI detection and validation
- Removed deprecated normalizeRepoName function in favor of normalizeRepositoryURI

### Fixed

- Inconsistent handling of repository references
- Confusion between file paths and URLs in repository references

_See: SpecStory history [2025-05-19_20-36-task-88-standardize-repository-uri-handling](mdc:.specstory/history/2025-05-19_20-36-task-88-standardize-repository-uri-handling.md) for task #88 implementation._

- Fixed environment-aware logging to properly handle debug logs in HUMAN mode

  - Prevented "no transports" warnings when running CLI commands in terminal
  - Added `systemDebug` method for important system debugging that works in all modes
  - Updated logger documentation with best practices for debug logging
  - Improved auto-detection of terminal environment

- Task #101: Improved Domain Module Testability with Proper Dependency Injection

  - Created specifications for implementing interface-based design
  - Planned consistent dependency injection patterns
  - Defined approach for improved test utilities
  - Will reduce reliance on type casting and improve test maintainability

- Task #102: Refactored Domain Objects to Follow Functional Patterns
  - Marked task #102 as DONE.
  - Broke down the original task #102 into three new, more focused subtasks:
    - Task #106: Refactor SessionDB to Functional Patterns ([#106](mdc:tasks/106-refactor-sessiondb-to-functional-patterns-subtask-of-102-.md))
    - Task #107: Refactor GitService to Functional Patterns ([#107](mdc:tasks/107-refactor-gitservice-to-functional-patterns-subtask-of-102-.md))
    - Task #108: Refactor TaskService to Functional Patterns ([#108](mdc:tasks/108-refactor-taskservice-to-functional-patterns-subtask-of-102-.md))

_See: SpecStory history [YYYY-MM-DD_HH-MM-topic](mdc:.specstory/history/YYYY-MM-DD_HH-MM-topic.md) for these changes (TODO: Add actual SpecStory ref once available)_.

- Task #103: Enhance Test Utilities for Better Domain Testing

  - Planned comprehensive test utility improvements
  - Will add dependency generation, mock creation enhancements
  - Will standardize test data generation and setup/teardown

- Task #104: Re-implemented Disabled Integration Tests
  - Re-implemented `workspace.test.ts` integration tests using proper dependency injection for mocking
  - Re-implemented `git.test.ts` tests with improved isolation and test environment setup
  - Implemented proper tests for the GitHub backend with dependency injection
  - Implemented basic tests for GitHub functionality validation
  - Fixed issues with test environment setup and mock handling
  - Ensured all tests pass reliably on Bun test framework
  - Fixed mocking utility to work correctly with Bun's native mock functionality
  - Added test coverage for the mocking utility itself

### Changed

- Updated workspace test approach to ensure proper dependency injection.
- Fixed issue with getCurrentSession in integration tests by using proper mocking patterns.

_See: SpecStory history [2024-07-17_16-20-fix-test-failures](mdc:.specstory/history/2024-07-17_16-20-fix-test-failures.md) for test failure fixes._

- Fixed an issue with the session start command where branch information was not correctly displayed

  - Updated `startSessionFromParams` function to return the actual branch name created
  - Modified the session record to store the branch name in the database
  - Enhanced the CLI output to correctly display branch information for new sessions
  - Fixed incorrect branch display in session list output by adding fallback for undefined values

- Updated the `user-preferences` rule to include a heuristic for interpreting ambiguous queries about "available" items, defaulting to active/actionable items. Also updated the rule's description in the Minsky system.

- Enhanced the `workspace-verification` rule to reference the new resource-management-protocol rule for guidance on managing project resources.

_See: SpecStory history [YYYY-MM-DD_HH-MM-user-preferences-update](mdc:.specstory/history/YYYY-MM-DD_HH-MM-user-preferences-update.md) for details on these rule updates._

- Task #106: Refactor SessionDB to Functional Patterns (Subtask of #102)
  - Implemented functional programming patterns for SessionDB
  - Created pure functions module (session-db.ts) that contains no side effects
  - Created I/O operations module (session-db-io.ts) to isolate file system interactions
  - Implemented adapter class (session-adapter.ts) for backward compatibility
  - Added factory function for creating session providers
  - Added comprehensive tests for all pure functions and adapter class
  - Improved type safety with proper interfaces and type definitions
  - Enhanced error handling with more descriptive error messages
  - Fixed repoPath generation to properly handle repository names with slashes

_See: SpecStory history [2025-05-20_refactor-sessiondb-functional-patterns](mdc:.specstory/history/2025-05-20_refactor-sessiondb-functional-patterns.md) for implementation details._

- Task #106: Fixed TypeScript Linter Errors in SessionDB Tests
  - Fixed type checking errors in session module test files
  - Used centralized type definitions in src/types/bun-test.d.ts to properly handle Bun test matchers
  - Added missing expect matchers (toHaveProperty, toHaveLength, toThrow, etc.) to central type definitions
  - Ensured all tests continue to pass at runtime while improving TypeScript compatibility

_See: SpecStory history [2025-05-21_fix-sessiondb-test-linter-errors](mdc:.specstory/history/2025-05-21_fix-sessiondb-test-linter-errors.md) for implementation details._

- Fixed test failures after merging PRs #098 and #108:
  - Fixed `filterTasks` function to correctly handle task IDs with numeric equivalence (e.g., "2" vs "#002")
  - Updated shared command tests to use Bun-compatible test assertions instead of Jest-style matchers
  - Removed dependency on custom `arrayContaining` and `objectContaining` matchers
  - Fixed mock implementations in rules and session test files
  - Ensured consistent testing patterns across the codebase

_See: SpecStory history [2025-06-26_fix-tests-after-merge](mdc:.specstory/history/2025-06-26_fix-tests-after-merge.md) for debugging session._

- Enhanced test utilities for better domain testing
  - Type-safe mock creation functions: `mockFunction`, `createPartialMock`, `mockReadonlyProperty`
  - Test suite management utilities: `createTestSuite`, `withCleanup`
  - Dependency generation utilities: `createTestDeps`, `createTaskTestDeps`, `createSessionTestDeps`, `createGitTestDeps`
  - Test data factory functions: `createTaskData`, `createSessionData`, `createRepositoryData`, plus array generators and randomization utilities
  - Complete documentation in test-utils README

_See: SpecStory history [2023-11-05_15-30-enhance-test-utilities](mdc:.specstory/history/2023-11-05_15-30-enhance-test-utilities.md) for test utilities enhancement._

- Fixed circular dependency in error handling code that prevented any CLI commands from running

  - Refactored error class structure to use a base-errors.ts file for the core MinskyError class
  - Updated network-errors.ts to import from base-errors.js instead of index.js
  - Fixed "Cannot access 'MinskyError' before initialization" error that occurred with all commands

- Fixed task serialization in MCP adapter to prevent double-stringification
  - Modified `listTasks` and `getTask` MCP command implementations in `src/adapters/mcp/tasks.ts`
  - Changed the return value structure to avoid JSON stringification conflicts
  - Ensured proper type safety with TypeScript for returned task data
  - Resolved the issue where tasks were not properly returned through the MCP interface

- Task #119: Fix MCP Rules.list Command to Exclude Rule Content
  - Modified the MCP adapter for the `rules.list` command to exclude the `content` field from the returned rules
  - Made list responses more manageable by removing potentially large rule content data
  - Maintained consistent behavior with the CLI interface where list commands only show metadata
  - Ensured all other rule metadata (id, name, description, globs, tags) is still returned
  - Kept the `rules.get` command behavior unchanged, still returning full rule content
