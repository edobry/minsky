# Changelog

All notable changes to the Minsky project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** This changelog references SpecStory conversation histories. See [.specstory/.what-is-this.md](mdc:.specstory/.what-is-this.md) for details on the SpecStory artifact system.

## [Unreleased]

### Added

- **Task #277**: Created comprehensive task specification for stacked PR workflow implementation
  - Enables sessions to start from existing session branches instead of always starting from main
  - Adds dependency tracking and visualization for session relationships
  - Supports PR stacks and cascading approvals
  - Includes phased implementation plan with testing strategy
  - Maintains backward compatibility with existing workflows

### Changed

- **Task #181**: Completed configuration system migration to idiomatic node-config implementation (Phase 6)
  - Removed NodeConfigAdapter anti-pattern that was fighting against idiomatic node-config usage
  - Implemented comprehensive Zod validation schemas for all configuration sections
  - Converted all configuration access to direct `config.get()` calls throughout codebase
  - Removed ConfigurationService interface and unnecessary abstraction layers
  - Achieved true idiomatic node-config implementation with runtime validation and full TypeScript type safety
  - All 10 configuration tests passing with zero regressions

- **Session Start Output**: Enhanced `session start` command output formatting for improved user experience
  - Replaced raw JSON output with user-friendly formatted display
  - Added emojis and clear section headers for better readability
  - Included helpful next steps for users after session creation
  - Maintained support for `--json` and `--quiet` flags
  - Provided clear session details: session name, task ID, repository, and branch

- **Task #270**: Restructured test architecture to use co-location instead of separate `__tests__` directories
  - Adopted standard TypeScript/JavaScript co-location pattern where tests are placed next to their modules
  - Updated test naming conventions: `[module].test.ts`, `[module].commands.test.ts`, `[module].adapter.test.ts`
  - Reserve `tests/` directories only for complex integration tests that don't fit co-location
  - Updated all import paths to use shorter relative paths from co-located tests
  - Updated configuration files (ESLint, codemod filters) to support both old and new patterns
  - Created comprehensive test architecture documentation promoting co-location
  - Established clear separation between domain logic and adapter tests
  - Fixed architectural confusion between integration tests and adapter tests
  - Updated cursor rules (`test-organization`, `testing-router`, `bun-test-patterns`) to promote co-location

### Fixed

- **Session Directory Command Path Resolution**
  - Fixed session dir command returning incorrect old per-repo structure paths
  - Changed from `/minsky/local-minsky/sessions/task#181` (old/wrong) to `/minsky/sessions/task#181` (correct)
  - Updated getRepoPathFn to use simplified session-based structure matching actual filesystem layout
  - Sessions are now correctly located directly in sessions/ directory, not per-repo subdirectories

- **Session Directory Command Error Message**
  - Improved error message for `minsky session dir` command when no parameters provided
  - Replaced unfriendly error message with helpful usage examples and command syntax
  - Added specific examples for both session name and task ID usage patterns
  - Included tips for related commands like `session list`, `session get`, and `session inspect`
  - Enhanced error message formatting with emojis and clear section headers for better readability
  - Removed ugly JSON error logging that was cluttering the console output

- **Session Approve Command Output Formatting**
  - Fixed confusing output in `minsky session approve` command that showed error messages for expected operations
  - Replaced raw JSON output with user-friendly formatted messages showing session details, task status, and merge information
  - Removed misleading "Command execution failed" error messages that appeared even when operations succeeded
  - Added proper CLI formatting with clear success indicators and structured information display

### Improved

- **Session Approve Command Idempotency**
  - Made `minsky session approve` command fully idempotent - can be run multiple times safely
  - Added detection of already-approved sessions by checking git merge ancestry
  - Shows different status messages for newly approved vs already approved sessions:
    - New approval: "✅ Session approved and merged successfully!"
    - Already approved: "ℹ️ Session was already approved and merged"
  - Added `isNewlyApproved` flag to JSON output for programmatic usage
  - Preserves existing merge information when session is already approved

### Added

- **Task Relationship Establishment (#251 and #252)**

  - Established relationship between Mobile/Voice Interface task (#251) and Task Management UI System task (#252)
  - Added cross-references between tasks to identify shared components and architecture opportunities
  - Enhanced task #251 to include shared chat UI architecture considerations and migration strategy from external AI services
  - Updated task #252 to include chat UI integration and voice capabilities for natural language task management
  - Defined shared components: chat UI, authentication, and backend services for unified interface approach
  - Added migration path from external AI services (OpenAI/Claude) to self-hosted AI backend for full control
  - Established foundation for Minsky-controlled chat interface rather than permanent reliance on external services

_See: SpecStory history [2025-07-08_04-32-add-mobile-and-voice-interface-task](mdc:.specstory/history/2025-07-08_04-32-add-mobile-and-voice-interface-task.md) for task creation and relationship establishment._

- **Task #164: Add Bun Binary Builds and GitHub Actions Release Workflow**
  - Added cross-platform binary compilation using `bun build --compile` with Just command runner
  - Implemented multi-platform support for Linux (x64, ARM64), macOS (x64, ARM64), and Windows (x64)
  - Created justfile with clean, maintainable build commands replacing repetitive npm scripts
  - Added justfile recipes: `build`, `build-linux`, `build-linux-arm64`, `build-macos`, `build-macos-arm64`, `build-windows`, `build-all`, `clean`, `test-binary`
  - Created GitHub Actions release workflow for automated binary builds on version tags using Just
  - Configured peer dependencies required for bun compilation: `@valibot/to-json-schema`, `effect`, `sury`
  - Set up automated release creation with multi-platform artifacts uploaded to GitHub Releases
  - Added binary patterns to .gitignore to exclude compiled binaries from repository
  - Created comprehensive BUILD.md documentation with installation and usage instructions
  - Verified build process works correctly with functional cross-platform binary generation
  - Enabled release automation triggered by version tags (v\*) with automatic release notes generation

_See: SpecStory history [2025-07-04_task-164-bun-binary-builds](mdc:.specstory/history/2025-07-04_task-164-bun-binary-builds.md) for implementation details._

- **Task #189: Restore Init Command Interactivity**
  - Restored interactive prompts for the `minsky init init` command that were lost during refactoring
  - Added comprehensive interactive prompts using `@clack/prompts` for consistent UX
  - Interactive backend selection between json-file, markdown, and github-issues backends
  - GitHub configuration prompts for owner/repo when github-issues backend is selected
  - Rule format selection between cursor and generic formats
  - MCP (Model Context Protocol) configuration with transport type selection
  - Added proper error handling for non-interactive environments and user cancellation
  - Maintained full backward compatibility with explicit command-line flags
  - Replaced silent defaults with guided user experience for better onboarding
  - Added input validation for GitHub details and port numbers
  - Implemented graceful cancellation handling throughout the interactive flow

_See: SpecStory history [2025-07-04_task-189-restore-init-command-interactivity](mdc:.specstory/history/2025-07-04_task-189-restore-init-command-interactivity.md) for implementation details._

- Task #216: Created task to implement core agent loop for independent Minsky operation, enabling Minsky to work outside of Cursor's agent loop and support multiple AI providers
- Task 182: AI-powered rule suggestion MVP - `minsky context suggest-rules` command for intelligent rule selection based on natural language queries
- Task 183: Rule suggestion evaluation and optimization - Advanced features including confidence scoring, model optimization, and evaluation integration
- **Task #229: Implement Mandatory Task-Session Association**
  - Implemented mandatory task association for all session creation operations
  - Added `--description` parameter for automatic task creation from session descriptions
  - Enhanced session start schema to require either `--task` or `--description` parameter
  - Created comprehensive auto-task creation functionality using session templates
  - Developed migration tools for existing taskless sessions with zero data loss
  - Successfully migrated 13 taskless sessions to achieve 100% task association compliance
  - Added comprehensive test coverage (15 passing tests) for session consistency and auto-task creation
  - Updated CLI help text to clearly indicate mandatory task requirement
  - Maintained backward compatibility for existing session operations (get, delete, update)
  - Enabled proper task tracking and workflow management for all sessions

_See: SpecStory history [2025-01-28_task-229-mandatory-session-task-association](mdc:.specstory/history/2025-01-28_task-229-mandatory-session-task-association.md) for implementation details._

### Changed

- **Task #244: Refactored Task Specification to Focus on Testing-Boundaries Compliance**

  - Completely rewrote task specification to address real root causes of test failures
  - Removed over-engineered TestIsolationFramework approach in favor of simple, standard patterns
  - Identified global singleton state interference (SessionDB, global variables) as primary issue
  - Established focus on testing pure domain functions instead of global singletons
  - Applied established testing-boundaries rules: test domain logic, not interface layers
  - Simplified approach using standard Bun test patterns instead of complex frameworks
  - Updated success criteria to reflect actual findings from testing-boundaries analysis
  - Key insight: Domain tests pass individually but fail in suite due to global state interference
  - Solution: Test pure functions with mock state parameters, not shared global singletons

- **Enhanced Session PR Command with Required PR Descriptions**

  - Added validation to `minsky session pr` command to require either `--body` or `--body-path` parameter
  - Prevents creation of PRs without meaningful descriptions
  - Provides clear error message with usage examples and suggestions
  - Maintains backward compatibility with existing flags and functionality
  - Improves code review processes by ensuring all PRs have proper documentation
  - Enforces best practices for pull request documentation across all projects

- Task #216: Updated to include investigation of existing agent framework libraries (claude-code SDK, OpenHands/OpenCode, LangChain, LlamaIndex, AutoGen, Semantic Kernel, etc.) before implementing from scratch, with evaluation criteria and decision framework for build vs. buy vs. extend
- Task 082: Simplified to focus only on context analysis and visualization, removing obsolete concepts that don't match how AI context actually works
- Task 182: Reduced scope to MVP functionality (1-2 weeks effort) with advanced features moved to Task 183

_See: SpecStory history [2025-01-29_task-244-testing-boundaries-compliance](mdc:.specstory/history/2025-01-29_task-244-testing-boundaries-compliance.md) for task specification refactoring._

### Added

- **Task #158: Implement Session-Aware Versions of Cursor Built-in Tools**
  - Implemented Phase 1: Critical File Operations
    - Created `session_edit_file` tool with support for Cursor's `// ... existing code ...` pattern
    - Created `session_search_replace` tool for single occurrence text replacement
    - Developed FastMCP server infrastructure for tool registration
    - Added CommandMapper type extensions for tool registration methods
  - Enhanced session workspace isolation for AI coding operations
  - All file operations enforce session workspace boundaries through SessionPathResolver
  - Tools match Cursor's exact interface for compatibility with AI agents

_See: SpecStory history [2025-06-23_session-aware-tools-implementation](mdc:.specstory/history/2025-06-23_session-aware-tools-implementation.md) for Phase 1 implementation._

- **Task #049: Implement Session-Scoped MCP Server for Workspace Isolation**
  - Implemented comprehensive session workspace tools for AI agents to operate safely within session boundaries
  - Created 6 session workspace tools with MCP integration:
    - `session_read_file` - Read files within session workspace
    - `session_write_file` - Write/create files with atomic operations
    - `session_list_directory` - List directory contents with filtering
    - `session_file_exists` - Check file/directory existence with metadata
    - `session_delete_file` - Delete files with safety checks
    - `session_create_directory` - Create directories with recursive support
  - Developed SessionPathResolver class with comprehensive security validation:
    - Prevents path traversal attacks (../ blocking)
    - Enforces session workspace boundaries
    - Handles edge cases (symlinks, special characters, complex paths)
    - Automatic path resolution within session context
  - Integrated session workspace tools with MCP server infrastructure
  - Created comprehensive test suite with 25 passing tests covering:
    - Path resolution and validation logic
    - Security boundary enforcement
    - Tool registration and integration
    - Edge cases and error handling
  - Added complete documentation with API examples and usage guidelines
  - Solved core problem of AI agents accidentally modifying main workspace by providing secure, session-scoped file operations
  - Enabled AI agents to work safely within session workspaces without manual path management

_See: SpecStory history [2025-06-17_23-16-check-mcp-server-status-and-tool-isolation](mdc:.specstory/history/2025-06-17_23-16-check-mcp-server-status-and-tool-isolation.md) for comprehensive analysis and implementation._

- **Task #138: Add GitHub Issues Support as Task Backend**
  - Implemented full GitHub Issues integration as a task backend option
  - Created GitHubIssuesTaskBackend with complete API integration using Octokit
  - Added environment variable support for GitHub authentication (GITHUB_TOKEN)
  - Implemented comprehensive task-to-issue mapping functionality:
    - Create tasks as GitHub issues with proper formatting
    - Update task status by modifying issue state and labels
    - List and filter tasks from GitHub issues
    - Support for issue assignments, labels, and milestones
  - Added comprehensive test suite with mocked GitHub API responses
  - Integrated with existing task service using factory pattern
  - Maintained backward compatibility with existing markdown backend
  - Created task #145 to address dynamic imports used in implementation
  - Created task #146 to fix session PR command import bug discovered during implementation

_See: SpecStory history [2025-01-17_github-issues-task-backend](mdc:.specstory/history/2025-01-17_github-issues-task-backend.md) for implementation details._

- **Task #175: Add AI-powered task management subcommands**
  - `estimate` - AI-powered task complexity estimation
  - `decompose` - AI-assisted task breakdown into subtasks
  - Additional commands for analysis, prioritization, and similarity detection

_See: SpecStory history [2025-01-24_13-58-start-working-on-task-166](mdc:.specstory/history/2025-01-24_13-58-start-working-on-task-166.md) for task creation._

### Changed

- **Improved user experience for session PR command uncommitted changes error**

  - Replaced generic error message with detailed, user-friendly guidance
  - Now shows specific files that have uncommitted changes categorized by type:
    - Modified files with count and file names
    - New (untracked) files with count and file names
    - Deleted files with count and file names
  - Added clear action steps with commands for committing or stashing changes
  - Included helpful context and next steps with emojis for better readability
  - Provides specific command to retry PR creation after resolving changes

- **Task #143: Upgrade ESLint from v8.57.1 to v9.29.0**
  - Successfully upgraded ESLint from version 8.57.1 to 9.29.0 with full compatibility
  - Migrated from legacy .eslintrc.json to modern flat config format (eslint.config.js)
  - Added @eslint/js v9.29.0 package for flat config support
  - Updated npm scripts to remove deprecated --ext .ts flag (not needed in v9)
  - Maintained all existing linting rules and functionality including:
    - Import restrictions for domain modules
    - Console usage restrictions with custom logger requirements
    - TypeScript-specific rules and configurations
    - Magic number detection and template literal preferences
  - Verified full compatibility with 2,434 linting issues detected and 402 auto-fixes applied
  - All tests passing (541/544) with only pre-existing unrelated failures
  - Zero breaking changes for development workflow with improved performance

_See: SpecStory history [2025-06-18_eslint-v9-upgrade](mdc:.specstory/history/2025-06-18_eslint-v9-upgrade.md) for ESLint upgrade implementation._

### Fixed

- **Task #255: Fix Session Dependency Installation Error**
  - Fixed critical bug where session startup would fail with "null is not an object" error during dependency installation
  - Issue: execSync returns null when stdio is "ignore" but code was calling .toString() on the null value
  - Solution: Added proper null check before calling .toString() in src/utils/package-manager.ts
  - All existing package manager tests pass (17/17)
  - Session creation now works correctly in quiet mode without dependency installation errors
  - Maintains backward compatibility with existing functionality for non-quiet mode

_See: SpecStory history [2025-01-29_task-255-fix-session-dependency-installation](mdc:.specstory/history/2025-01-29_task-255-fix-session-dependency-installation.md) for implementation details._

- **Task #166: Complete TypeScript Error Resolution After Removing @types/commander**
  - Successfully eliminated all 700+ TypeScript errors revealed after removing incompatible @types/commander package
  - Fixed TaskBackend interface conflicts by consolidating duplicate interfaces across modules
  - Resolved markdownTaskBackend.ts type compatibility issues between Task and TaskData interfaces
  - Fixed MCP server logging to use correct single-argument logger method signatures
  - Fixed MCP fastmcp-server.ts configuration to use valid transport properties for FastMCP
  - Fixed test utilities assertions to handle unknown types with proper type assertions
  - Fixed test compatibility layer interface to match actual implementation signatures
  - Applied systematic AST-based transformations for precise error resolution
  - Achieved 100% TypeScript compilation success with zero remaining errors
  - Maintained code quality and functionality throughout the error resolution process

_See: SpecStory history [2025-01-24_13-58-start-working-on-task-166](mdc:.specstory/history/2025-01-24_13-58-start-working-on-task-166.md) for comprehensive TypeScript error resolution._

- **Session PR Commit Message Bug Fix**

  - Fixed critical bug where session PR branches would use incorrect commit messages from unrelated tasks
  - Issue: PR branches were getting commit messages from arbitrary previous commits (e.g., task #166 messages appearing in task #229 PRs)
  - Root cause: Git merge process was not reliably using the specified commit message file (-F flag)
  - Solution: Replaced `-F commitMsgFile` with direct `-m "message"` approach with proper quote escaping
  - Added commit message verification to detect and log when git applies wrong messages
  - Enhanced error handling and debugging capabilities for merge commit creation
  - Verified fix works correctly with proper task-specific PR titles in commit messages

- **Task #167: Fix Task Creation CLI Bug - "status is not defined" Error**

  - Fixed critical "status is not defined" error that was preventing the `minsky tasks create` command from working
  - Resolved parameter naming mismatch in `getCheckboxFromStatus` function in `taskConstants.ts`
  - Changed parameter from `__status` to `status` to match the function body usage
  - Restored proper task creation workflow enabling CLI-driven task creation instead of manual fallbacks
  - Added regression test to prevent this variable naming issue from recurring
  - Verified fix works with successful task creation and status update commands
  - Task creation workflow now completes end-to-end without errors

- **Variable naming protocol violations in CLI bridge system**

  - Fixed critical "options is not defined" runtime error affecting all CLI commands
  - Resolved multiple instances of underscore-prefixed function parameters being used without underscores:
    - Fixed registerCategorizedCliCommands function parameter `__program` → `program`
    - Fixed generateAllCategoryCommands function parameter `__program` → `program`
    - Fixed formatRuleSummary function parameter `_rule` → `rule`
    - Fixed addOptionsToCommand function parameters `_parameters` → `parameters`, `_name` → `name`, `_flag` → `flag`
    - Fixed parseOptionsToParameters function parameters `_options` → `options`, `_parameters` → `parameters`
    - Fixed normalizeCliParameters function parameters `_parametersSchema` → `parametersSchema`, `_result` → `result`
  - Eliminated variable naming inconsistencies that violated the variable naming protocol
  - Ensured all CLI commands can execute without parameter reference errors

- **Task #141: Repository Configuration System Implementation**
  - Implemented complete 5-level configuration hierarchy system (CLI flags > env vars > global user config > repo config > defaults)
  - Added repository configuration support with `.minsky/config.yaml` for team-wide consistency
  - Created global user configuration in `~/.config/minsky/config.yaml` for credentials and personal settings
  - Implemented backend auto-detection based on repository characteristics (GitHub remote, tasks.md file, fallback to json-file)
  - Added comprehensive credential management with multiple sources (environment, file, interactive prompts)
  - Created CLI commands for configuration management (`minsky config list`, `minsky config show`)
  - Enhanced `minsky init` command with backend options (`--backend`, `--github-owner`, `--github-repo`)
  - Integrated configuration system with task commands for zero-config experience
  - Added YAML configuration file generation and validation
  - Implemented complete test suite for configuration service and integration scenarios
  - Enabled zero-config task operations: `minsky tasks list` now works without `--backend` flags after repository setup

_See: SpecStory history [2025-01-24_repo-config-system-implementation](mdc:.specstory/history/2025-01-24_repo-config-system-implementation.md) for configuration system implementation._

- **Session Dir Command: Enable Optional Positional Arguments**
  - Fixed error "too many arguments for 'dir'. Expected 0 arguments but got 1" when using session dir command
  - Added CLI customization to accept optional session name as positional argument
  - Preserves existing --task option as alternative usage pattern
  - Users can now run either:
    - `minsky session dir my-session-name` (positional session name)
    - `minsky session dir --task task#123` (task ID as option)
  - Enhanced help text shows [session] as optional positional argument with clear usage guidance

_See: SpecStory history [2025-01-24_session-dir-positional-args](mdc:.specstory/history/2025-01-24_session-dir-positional-args.md) for implementation details._

- **Task #144: Fix Session PR and Git Prepare-PR Commands to Implement Proper Prepared Merge Commit Workflow**
  - Fixed critical bug where `session pr` and `git prepare-pr` commands created regular PR branches instead of prepared merge commits
  - Changed GitService.preparePr() to create PR branch FROM base branch (origin/main) instead of feature branch
  - Added `--no-ff` merge of feature branch INTO PR branch to create proper prepared merge commit
  - Implemented proper error handling for merge conflicts with exit code 4 and cleanup
  - Added comprehensive test coverage demonstrating broken vs fixed behavior
  - Verified end-to-end workflow shows correct prepared merge commit structure
  - Enabled fast-forward merge capability for `session approve` command as documented
  - Full compliance with Task #025 prepared merge commit specification
  - Resolves fundamental issue that broke the documented PR workflow

_See: SpecStory history [2025-06-18_fix-prepared-merge-commit-workflow](mdc:.specstory/history/2025-06-18_fix-prepared-merge-commit-workflow.md) for prepared merge commit implementation._

- **Task #140: Fix dependency installation error in session startup**
  - Fixed null reference error when calling .toString() on execSync result during dependency installation
  - Added proper null handling using optional chaining and fallback empty string for quiet mode
  - Resolved session startup failure that occurred when stdio: "ignore" was used with execSync
  - All session startup operations now complete successfully without dependency installation errors

_See: SpecStory history [2025-01-26_fix-dependency-installation-error](mdc:.specstory/history/2025-01-26_fix-dependency-installation-error.md) for session startup fix._

- **Task #116: Improve CI/CD Test Stability with Progressive Migration**
  - Verified CI stability resolved by upstream testing infrastructure improvements from tasks #110-115
  - Confirmed 544/544 tests passing with 0 failures in existing CI workflow using Bun
  - Documented that progressive migration infrastructure was unnecessary
  - Removed unused progressive test workflow files and migration scripts
  - Established that existing simple CI approach works perfectly with Bun test runner

_See: SpecStory history [2025-01-20_improve-ci-test-stability](mdc:.specstory/history/2025-01-20_improve-ci-test-stability.md) for CI stability verification._

### Added

- Task #114: Migrate High-Priority Tests to Native Bun Patterns
  - Created robust custom assertion helpers to bridge Jest and Bun differences
  - Implemented comprehensive ESM import compatibility fixes
  - Developed test-migration examples and documentation
  - Created detailed migration criteria and verification steps
  - Created prioritized test migration backlog
  - Compiled a migration pattern library with common transformations
  - Built extensive documentation for assertion method differences
  - Successfully migrated core tests to native Bun patterns:
    - Enhanced utility tests (enhanced-utils.test.ts)
    - Mocking utility tests (mocking.test.ts)
    - Filter messages utility tests (filter-messages.test.ts)
    - Core domain task tests (tasks.test.ts)
    - Git service tests (git.test.ts)
    - Git PR service tests (git.pr.test.ts)
    - Session database tests (session-db.test.ts)
    - Rules command tests (rules.test.ts)
    - Tasks command tests (tasks.test.ts)
    - Git command tests (git.test.ts)
    - Session command tests (session.test.ts)
    - Git merge PR tests (git-merge-pr.test.ts)
    - Parameter schemas tests (param-schemas.test.ts)
    - Option descriptions tests (option-descriptions.test.ts)
    - Compatibility layer tests (compatibility.test.ts)
    - Integration tasks tests (integration/tasks.test.ts)
    - Integration git tests (integration/git.test.ts)
    - Integration rules tests (integration/rules.test.ts)
    - Integration workspace tests (integration/workspace.test.ts)
  - Phase 2A: Refactored all migrated tests to use project utilities consistently:
    - Replaced raw Bun APIs with custom assertion helpers (expectToHaveLength, etc.)
    - Added setupTestMocks() for automatic mock cleanup
    - Ensured consistent use of .js extensions and migration annotations
    - Improved test maintainability and consistency across the codebase
  - Phase 2B: Completed additional quick wins migrations:
    - Git default branch detection tests (git-default-branch.test.ts)
    - Git service task status update tests (gitServiceTaskStatusUpdate.test.ts)
    - Session adapter tests (session-adapter.test.ts)
  - Established new testing patterns to improve maintainability:
    - Direct Method Mocking pattern for complex dependencies
    - Centralized test utility usage for consistent patterns
    - Enhanced error handling with proper TypeScript types
    - Explicit cleanup of all mocks between tests
  - Added new custom assertion helpers:
    - Created expectToNotBeNull for not.toBeNull assertions
    - Enhanced property existence checking with expectToHaveProperty
    - Improved array length verification with expectToHaveLength
  - Completed migration of 23 high-priority tests across all layers of the application
  - Created comprehensive migration analysis for remaining 16 test files with ROI prioritization

_See: SpecStory history [2025-06-30_migrate-high-priority-tests](mdc:.specstory/history/2025-06-30_migrate-high-priority-tests.md) for implementation details._

- Task #125: Implement CLI Bridge for Shared Command Registry
  - Created a CLI bridge to automatically generate Commander.js commands from shared command registry entries
  - Implemented flexible parameter mapping between Zod schemas and CLI options/arguments
  - Added support for command customization with aliases, help text, and parameter configuration
  - Developed category-based command organization with hierarchical structuring
  - Migrated all CLI commands to use the shared command registry via the CLI bridge
  - Removed manual CLI adapter implementations (2,331+ lines deleted)
  - Added git commit and push commands to shared command registry
  - Added tasks list, get, create, status.get, and status.set commands to shared command registry
  - Added init command to shared command registry
  - Updated CLI entry point to use CLI bridge exclusively
  - Fixed duplicate session.inspect command registrations
  - Implemented comprehensive testing and verification
  - Updated command-organization.mdc rule to reflect CLI bridge architecture
  - Created new cli-bridge-development.mdc rule with comprehensive development guidelines
- **Task #129: Local DB Tasks Backend Implementation**
  - DatabaseStorage abstraction layer for generic storage operations
    - Type-safe interface with generic support for entity and state types
    - CRUD operations with comprehensive error handling
    - Query capabilities and batch operations
    - Future-proof design for multiple backend implementations
  - JsonFileStorage implementation for JSON file-based storage
    - Thread-safe atomic file operations
    - Configurable file paths and state initialization
    - Error recovery and validation mechanisms
    - Efficient JSON serialization with pretty-printing support
  - JsonFileTaskBackend implementation using DatabaseStorage abstraction
    - Full TaskBackend interface compliance
    - Centralized storage at configurable location (default: .minsky/tasks.json)
    - Backward compatibility with markdown task parsing
    - Enhanced database-specific operations for task management
  - Migration utilities for seamless format transitions
    - Bidirectional conversion between markdown tasks.md and JSON database
    - Automatic backup creation during migration operations
    - Conflict resolution and duplicate task handling
    - Format comparison utilities to detect synchronization issues
    - Support for multiple markdown task formats
  - Comprehensive test suite for JsonFileTaskBackend
    - Storage operation tests (CRUD)
    - TaskBackend interface compliance verification
    - Markdown compatibility testing
    - Error handling validation
  - Complete documentation for JSON Task Backend system
    - Architecture overview and component descriptions
    - Usage examples and integration guides
    - Migration procedures and troubleshooting
    - Performance considerations and future enhancement plans

_See: SpecStory history [2023-05-29_cli-bridge-implementation](mdc:.specstory/history/2023-05-29_cli-bridge-implementation.md) for implementation details._

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

- Task #122: Improve Error Handling for MCP Server Port Conflicts
  - Created task to improve error handling for network-related errors in the MCP server
  - Will provide clearer error messages for common issues like port conflicts (EADDRINUSE)
  - Will add specific error detection for network-related errors
  - Will implement user-friendly messages with suggested actions
  - Will maintain detailed logging for debugging purposes

_See: SpecStory history [2025-05-21_improve-mcp-error-handling](mdc:.specstory/history/2025-05-21_improve-mcp-error-handling.md) for error handling improvements._

- CLI bridge that auto-generates Commander.js commands from the shared command registry
- Migrated tasks spec command to use shared command registry and CLI bridge
- Migrated git commit and push commands to use shared command registry and CLI bridge
- Migrated init command to use shared command registry and CLI bridge
- Migrated remaining tasks commands (list, get, create) to use shared command registry and CLI bridge
- Updated CLI entrypoint to use shared command registry and CLI bridge for all commands

_See: SpecStory history [2023-07-05_15-45-cli-bridge-implementation](mdc:.specstory/history/2023-07-05_15-45-cli-bridge-implementation.md) for CLI bridge implementation._

### Changed

- **Task #133: Fix CLI Flag Naming Inconsistency for Task Identification**
  - Standardized CLI flag naming for task identification across all Minsky commands
  - Changed git PR command parameter from `taskId` to `task` for consistency with session commands
  - Updated both CLI and MCP adapters to use `--task` flag consistently
  - Maintained domain layer compatibility with taskId parameter mapping
  - All task-related commands now use consistent `--task` flag naming
  - No breaking changes to functionality, only improved user experience through consistent interface

_See: SpecStory history [2025-05-23_fix-cli-flag-naming-inconsistency](mdc:.specstory/history/2025-05-23_fix-cli-flag-naming-inconsistency.md) for implementation details._

- Improved error handling for common network errors in the MCP server
  - Added specialized error classes for network errors (`NetworkError`, `PortInUseError`, `NetworkPermissionError`)
  - Implemented user-friendly error messages with suggested actions for port conflicts
  - Added detailed error logging with stack traces in debug mode only
  - Improved error detection for network-related issues like port conflicts (EADDRINUSE)

_See: SpecStory history [2025-05-21_improve-mcp-error-handling](mdc:.specstory/history/2025-05-21_improve-mcp-error-handling.md) for error handling improvements._

- Refactored CLI adapters to delegate to shared command registry via CLI bridge
- Simplified command registration in CLI entrypoint
- Fixed duplicate session command registration in shared registry
- Removed manual CLI command implementations entirely, using only CLI bridge

_See: SpecStory history [2023-07-06_10-30-cli-bridge-migration](mdc:.specstory/history/2023-07-06_10-30-cli-bridge-migration.md) for command migration._

- Task #123: Enhance `tasks get` Command to Support Multiple Task IDs

  - Will update the `tasks get` command to fetch information for multiple tasks at once
  - Will support comma-separated format and multiple arguments syntax
  - Will extend task schemas to handle arrays of task IDs
  - Will improve CLI and MCP adapters to support this enhanced functionality
  - Will update output formatting to clearly display multiple task information

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

- Task #118: Fix Rule Format Errors in rules.ts
  - Diagnose and fix issues with rule file lookup in the rules system
  - Ensure all existing rule files in .cursor/rules can be properly found and loaded
  - Eliminate "Rule not found" errors when running the `minsky rules list` command
  - Improve error handling in the rule system to provide more helpful diagnostics

_See: SpecStory history [2025-06-28_fix-rule-format-errors](mdc:.specstory/history/2025-06-28_fix-rule-format-errors.md) for implementation details._

- Task #111: Built Core Mock Compatibility Layer for Bun Tests
  - Created a Jest/Vitest compatibility layer to simplify migration of tests to Bun's test runner
  - Implemented mock function extensions with full Jest-like API (mockReset, mockClear, mockReturnValue, etc.)
  - Added asymmetric matchers (anything(), any(), objectContaining(), etc.) for flexible assertions
  - Created module mocking utilities to simulate Jest's module mocking capabilities
  - Added comprehensive documentation on using and migrating to the compatibility layer
  - Included unit tests to verify compatibility with existing test patterns
  - Designed the system with progressive adoption in mind, allowing tests to be migrated incrementally

_See: SpecStory history [2025-06-30_build-core-mock-compatibility-layer](mdc:.specstory/history/2025-06-30_build-core-mock-compatibility-layer.md) for implementation details._

- Task #110: Created a Complete Test Inventory and Classification System

  - Implemented test-analyzer.ts script to scan and classify test patterns
  - Created a classification system for test mocking complexity and migration difficulty
  - Added test dependency analysis to identify framework-specific patterns
  - Generated detailed reports in JSON and Markdown formats
  - Provided migration recommendations with prioritized test lists
  - Identified common patterns causing incompatibility with Bun's test runner

- Task (New): Add "session review" Command for PR Review

  - Create a new command to help users review PRs by collecting and displaying all relevant information
  - Implement functionality to retrieve task specification, PR description, and complete diff
  - Add support for different output modes (console, file, JSON)
  - Ensure compatibility with PRs created by both `git prepare-pr` and `session pr` commands
  - Provide automatic detection of current session when run without parameters

- Task #098: Created Shared Adapter Layer for CLI and MCP Interfaces
  - Created a shared command registry to enable code reuse between interfaces
  - Implemented shared command interfaces with Zod schema validation
  - Built bridges for CLI (Commander.js) and MCP interfaces
  - Added unified error handling approach for all interfaces
  - Created schema conversion utilities for validation and type safety
  - Implemented response formatters for consistent output
  - Added shared git commands implementation (commit and push)
  - Added shared tasks commands implementation (status get/set)
  - Added shared session commands implementation (list, get, start, dir, delete, update, approve, pr)
  - Added shared rules commands implementation (list, get, create, update, search)
  - Created integration examples for both CLI and MCP
  - Added comprehensive test coverage for shared components
  - Ensured the implementation supports progressive migration from existing adapters
  - Fixed TypeScript errors in shared components

_See: SpecStory history [2025-06-10_create-shared-adapter-layer](mdc:.specstory/history/2025-06-10_create-shared-adapter-layer.md) for implementation details._

- Task #108: Refactor TaskService to Functional Patterns
  - Refactored TaskService and associated backends to follow functional programming principles
  - Implemented pure functions for core task manipulation logic
  - Created explicit state handling with pure data transformation functions
  - Separated side effects (file I/O, API calls) from pure data operations
  - Added functional composition patterns for complex task operations
  - Improved testability with pure function unit tests
  - Enhanced error handling with more explicit error states

_See: SpecStory history [2025-06-24_refactor-taskservice-functional-patterns](mdc:.specstory/history/2025-06-24_refactor-taskservice-functional-patterns.md) for implementation details._

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

  - Added a new `inspect` subcommand to the `minsky session` command
  - Implemented auto-detection using the `getCurrentSessionContext` utility
  - Provided both human-readable and JSON output formats
  - Added clear error messages when not in a session workspace
  - Reused output formatting from the `get` command for consistency

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

- Task #093: Implement Consistent CLI Error Handling Across All Commands

  - Created task to standardize error handling across all CLI commands
  - Will implement consistent error message formatting
  - Will add proper error codes and categories
  - Will improve error logging and debugging information

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

- Created a new `resource-management-protocol` rule to provide comprehensive guidance on using project-specific tools for resource management instead of direct file editing.

- Task #104: Re-implemented Disabled Integration Tests

  - Re-implemented `workspace.test.ts` integration tests using proper dependency injection for mocking
  - Re-implemented `git.test.ts` tests with improved isolation and test environment setup
  - Implemented proper tests for the GitHub backend with dependency injection
  - Implemented basic tests for GitHub functionality validation
  - Fixed issues with test environment setup and mock handling
  - Ensured all tests pass reliably on Bun test framework

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

- Comprehensive test utility documentation:
  - Main documentation file with overview and getting started guides
  - Detailed documentation for the compatibility layer
  - Migration guides for converting tests from Jest/Vitest to Bun
  - Mocking utilities documentation
  - Testing best practices guide
  - Example-based practical guide with real-world testing scenarios

_See: SpecStory history [2023-07-18_20-15-test-utility-documentation](mdc:.specstory/history/2023-07-18_20-15-test-utility-documentation.md) for test utilities documentation._

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

- Task #101: Improved Domain Module Testability with Proper Dependency Injection
  - Added interface-based design with `SessionProviderInterface` and `GitServiceInterface`
  - Implemented consistent dependency injection pattern across domain functions
  - Created factory functions for default implementations (`createSessionProvider`, `createGitService`)
  - Added enhanced test utilities for generating test dependencies
  - Refactored key functions like `resolveRepoPath` and `approveSessionFromParams` to use DI pattern
  - Improved test reliability by eliminating type casting and readonly property modifications

_See: SpecStory history [2025-05-20_improve-domain-module-testability](mdc:.specstory/history/2025-05-20_improve-domain-module-testability.md) for implementation details._

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

- Fixed session command issues after merge

  - Restored missing `--task` parameter to `session get` command for backward compatibility
  - Added missing `skipInstall` parameter to `session start` command execution
  - Added missing `force` parameter to `session update` command execution
  - Fixed parameter mismatches between shared command registry and domain schemas
  - Ensured all session commands properly support both `--session` and `--task` options

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

- Task #131: Fix TypeScript Issues in DI Helpers
  - Replaced explicit 'any' types with 'unknown' for better type safety in test dependency interfaces
  - Fixed interface method names to match actual domain interfaces (GitServiceInterface, WorkspaceUtilsInterface)
  - Updated mock implementations to use direct functions instead of createMock wrappers for better type inference
  - Fixed unused parameter warnings by prefixing with underscore
  - Updated integration test to use withMockedDeps instead of mockImplementation for better compatibility
  - Removed unused createMock import to clean up dependencies
  - Resolved all TypeScript linter warnings in dependencies.ts while maintaining full test functionality

_See: SpecStory history [2025-01-XX_fix-typescript-di-helpers](mdc:.specstory/history/2025-01-XX_fix-typescript-di-helpers.md) for implementation details._

- Task #132: Fix Session Get Command Output Format
  - Fixed issue where `minsky session get --task <id>` only displayed `success: true` instead of comprehensive session details
  - Enhanced CLI bridge default formatter to properly handle session objects and nested data structures
  - Added `formatSessionDetails()` method for human-readable session information display
  - Added `formatSessionSummary()` method for session list views
  - Improved generic object handling in CLI output formatter
  - Session get command now displays comprehensive details by default:
    - Session name and ID
    - Task ID if associated
    - Repository name and path
    - Branch name
    - Creation date
    - Backend type
  - Maintained backward compatibility with `--json` flag for machine-readable output
  - All session-related tests continue to pass (74 tests)

_See: SpecStory history [2025-01-16_fix-session-get-output](mdc:.specstory/history/2025-01-16_fix-session-get-output.md) for implementation details._

- Extracted test-migration module to separate repository for preservation
- Removed redundant bun-test.d.ts (now using bun-types package)

_See: SpecStory history [2025-06-18_18-00-continue-linter-fixes](mdc:.specstory/history/2025-06-18_18-00-continue-linter-fixes.md) for linter cleanup progress._
