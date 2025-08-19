# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Multi-backend string ID support system** (md#414)
  - Complete support for string-based task IDs (update-test, delete-test, UUIDs, etc.)
  - Perfect round-trip storage/retrieval consistency without ID corruption
  - Backend routing system supporting qualified IDs (md#update-test → update-test)
  - Full CRUD operations working seamlessly with any string ID format
  - Ready for GitHub Issues, Linear, and custom backend integration
  - Enhanced regex patterns and parsing logic for flexible ID formats
  - Resolved status constant inconsistencies (IN_PROGRESS vs IN-PROGRESS)
  - 100% test success rate across all multi-backend operations

- Task specification for automated task routing and implementation planning (md#442)
  - "Route to this task" feature that traverses dependency graphs to generate optimal implementation sequences
  - Intelligent pathfinding algorithms for task dependencies with multi-objective optimization
  - Parallel execution detection and resource-constrained planning
  - Integration with task hierarchy and dependency systems for automated "tech tree" traversal
  - Strategic routing with value-first, risk-minimized, and shortest-path optimization strategies
  - Dynamic re-routing as tasks complete and priorities change
  - Foundation for transforming manual implementation planning into automated, optimized process

- Task specification for MCP-based subagent system (md#441)
  - Comprehensive architecture for implementing subagents as MCP tools
  - Integration with task/session system for state management
  - OODA loop implementation based on Task #349 agent analysis
  - Ten phased implementation plan for progressive development
  - Support for customized tool manifests and rule selection per subagent
  - Conversation history tracking for execution analysis
  - Foundation for transitioning from passive to active agent control

- Enhanced task search output with immediate usability improvements

  - Task search results now display title, status, and spec path by default
  - Improved CLI format: `#. Title [ID] - Status` with numbered ranking and clear hierarchy
  - Reduced indentation for better readability and less visual clutter
  - `--details` flag support to include description in output
  - JSON output maintains backward compatibility with both enhanced and raw results
  - Enhanced output applies to both `tasks search` and `tasks similar` commands
  - Better readability while preserving programmatic access for tooling

- CLI ergonomics for session.edit_file (md#419)

  - Add `minsky session edit-file` CLI command as user-friendly wrapper
  - Support for reading edit patterns from stdin or `--pattern-file`
  - Session auto-detection from workspace context
  - Rich output formatting with dry-run previews and diff summaries
  - Comprehensive CLI documentation and examples

- feat(config): add workspace.mainPath; wire markdown/json task backends to main workspace path (md#410)
- session pr: status/backend/time filters

  - `minsky session pr list --status open,merged --backend github --since 7d --until 2025-08-01`
  - `minsky session pr get --task md#413 --status all --since 24h`
  - Status accepts comma-separated or `all`; backend: `github|remote|local`; time accepts `YYYY-MM-DD` or relative `7d|24h|30m`.

- tasks storage (md#315): add `backend` enum and `source_task_id` columns to `tasks` table; populate from qualified IDs; reuse centralized backend enum values from `enumSchemas.backendType`; update PG vector storage to write these fields.

- feat(session commit): enhanced output with commit summary and changed files (md#436)
  - Default human output prints short hash, subject, branch, author/time, diffstat
  - Per-file list with status codes; toggle with `--no-files`
  - `--oneline` renders `<hash> <subject> | <branch> | <N files, +X -Y>`
  - `--json` returns structured fields without extra logs

### Fixed

- tasks: Removed duplicate spec `md#415` for SessionDB migration cutover (duplicate of `md#401`); cleaned reference in `process/tasks.md`. The remaining `md#415` now exclusively tracks CLI error summarization follow-up.
- tasks: Added missing entry to `process/tasks.md` for `md#415` (Improve CLI Error Summarization with Structured Detection).

- tasks: Corrected misnumbered plan reference in `process/tasks.md` for "Automated Migrations Strategy (Boot-time/Orchestrated) and Remote Runs" from `md#1` to the proper existing task `md#426`.
- tasks: Deduplicated duplicate task entries in `process/tasks.md`:
  - Removed redundant `[ ]` entries for `md#428` (kept single `[+]` entry)
  - Removed duplicate `[ ]` entry for `md#421` (kept `[x]` entry)
  - Removed duplicate `md#399` entry so only one remains
  - Fixed incorrect plan link for `md#426` and removed conflicting `md#420` automated migrations entry
  - Renumbered plan/spec IDs to resolve collisions: `md#417→432`, `md#418→433`, `md#419→434`, `md#398 (fix)`→`md#435`
- tasks: Deduplicated conflicting entries for `md#427` in `process/tasks.md` so status reporting is consistent between `tasks status get` and `tasks list` (kept DONE as the single source of truth).
- docs(md#414): Updated task spec with current status and resolved session update conflicts for `task-md#414`; session brought current via CLI.

- sessiondb/postgres: Correct meta-table detection for Drizzle migrations

  - Fixed `PostgresStorage.hasPendingMigrations()` to look for `__drizzle_migrations` in the `drizzle` schema and to count from `drizzle.__drizzle_migrations`.
  - Resolves false "Database schema is out of date" errors when `drizzle-kit generate` and `drizzle-kit migrate` report no changes.

- **Tasks Search/Similar CLI Output**: `minsky tasks search` and `minsky tasks similar` now display human-friendly output in non-JSON mode, listing result IDs with scores and showing a result count, instead of only printing "✅ Success".
- **Similarity Threshold Default**: Removed overly strict default threshold that could filter out all results. If no threshold is provided, the search now uses a permissive default so matches are shown.
- Task md#425: Suppress [DEBUG] logs during `session start` unless debug is explicitly enabled. Replaced unguarded console logs with `log.debug(...)` in `startSessionFromParams` so they are hidden by default.
- **CLI stdout/stderr routing**: Normal command output now prints to stdout rather than stderr. `minsky tasks list` and similar commands write human-readable output to stdout; warnings/errors remain on stderr. Adjusted logger configuration in `src/utils/logger.ts` and `src/domain/utils/logger.ts` to keep only non-info levels on stderr.
- **Session PR List Output**: `minsky session pr list` now prints clean, human-friendly lines (no ASCII table). Shows `PR #<num> <status> - <title>` with session/task/updated info; `--verbose` adds branch and URL. `--json` remains structured.
  - Refined to a compact, high signal format: `#<num> [status] <title>  (s:<session>, t:<task>, <relative time>)`. `--verbose` adds indented `branch` and `url` lines. `--json` unchanged.
  - Harmonized title line with `session pr get` so both now render: `🟢 [feat] [md#123] Title text [#89]`. Removed redundant `PR #<num>` and `Backend:` labels from list details as they are already evident.
- tasks: `minsky tasks list` now correctly displays task IDs again. Restored ID rendering by enhancing `formatTaskIdForDisplay` to handle legacy (`#123`) and numeric (`123`) IDs, outputting qualified `md#NNN` in CLI list output. See commit 26d958bf3.

- feat(sessiondb): add Drizzle Kit migrations for PostgreSQL and wire runtime migrator
  - Added `drizzle.pg.config.ts` and generated PG migrations under `src/domain/storage/migrations/pg`
  - Updated `PostgresStorage.initialize()` to run migrations via `drizzle-orm/postgres-js/migrator`
  - Left existing SQLite config in `drizzle.config.ts` untouched for local dev
  - Docs: `docs/testing/postgres-migrations.md`

### Fixed

- CLI validation error formatting for Zod schema failures. Previously, invalid params could print a bare `❌ [` due to unhandled `ZodError`. Now errors are concise and human-readable (e.g., `Validation error: Task ID must be qualified (md#123, gh#456)`) with full details shown in debug mode. Affects `minsky session get`, `minsky session dir`, and other Zod-validated commands.

- **Session PR Merge (GitHub backend)**: Delegated approval validation to the repository backend and added explicit GitHub API approval checks before merge. Removed misleading "approved" wording from merge log. Clear, actionable error output now shows required vs current approvals and PR URL.
- **Task md#421**: Suppress low-value Octokit HTTP transport logs during `session pr merge` unless `--debug` is enabled. Added concise human-friendly status lines for approval count and branch protection summary before merging. Structured `--json` outputs unchanged.
- **Session Tasks File Resolution**: Fixed `session pr merge` post-merge task status update to resolve the main workspace to a local repo path before reading/writing `process/tasks.md`. Prevents malformed remote URL paths like `https:/github.com/.../process/tasks.md` and ensures updates and branch cleanup run against the main repository instead of the session workspace.

- **Session Review/Approve Backend Delegation (md#410)**: Removed direct `pr/` branch assumptions from session review and approval flows. Introduced backend APIs `getPullRequestDetails()` and `getPullRequestDiff()` and implemented them for GitHub, Local, and Remote backends. Session review now fetches PR description and diff via the repository backend; approval flow gates stash/branch cleanup to non-GitHub backends and delegates merge/approval to backend.

- **Session Start GitHub Auto-Detect (md#435)**: Domain `startSessionImpl` now honors `repository.default_repo_backend=github` by auto-detecting the GitHub remote when `--repo` is not provided, persisting `backendType` accordingly. The CLI adapter is thin and delegates entirely to the domain implementation.

### Added

- **Session PR Edit Command**: Implemented `session pr edit` command for updating existing pull requests

- **Configuration**: Added `workspace.mainPath` integration across task backends (Markdown/JSON) and environment mapping (`MINSKY_WORKSPACE_MAIN_PATH`). Backends prefer `workspace.mainPath` for main workspace resolution.

### Tests

- test(md#399): Restored and expanded Morph Fast Apply integration tests for `session.edit_file` (TypeScript only)

  - Reintroduced helpers and fixtures, enabled Phases 1–3
  - Added 4 cases: sequential edits, delete/removal, ambiguous/conflict, formatting preservation
  - All 22 TS cases pass against real Morph configuration

  - Separate `session pr create` and `session pr edit` functionality - create fails if PR already exists
  - Added `updatePullRequest` method to `RepositoryBackend` interface for backend-specific PR updates
  - GitHub backend uses GitHub API directly (no local conflict checks, server handles conflicts)
  - Local/Remote backends delegate to existing `sessionPr` logic with conflict checks (appropriate for git workflows)
  - Auto-detect PR number from current git branch for GitHub backend
  - Improved error messages and validation for both create and edit operations
  - Backend delegation allows each repository type to handle PR updates appropriately

- test(md#412): Comprehensive integration tests for `session.edit_file` with Cursor parity

  - Specifically-invoked integration suite using real Morph Fast Apply API
  - Phases 1–3 TypeScript scenarios with expected outcomes and validation helpers
  - Enhanced AI completion path wired with intelligent retry and circuit breaker
  - Skips gracefully when Morph is not configured; logs structured diagnostics

- **Task md#407**: Extract shared DB service for sessions, tasks metadata, and embeddings (pgvector)

  - Introduces a new task to define a general-purpose `DbService` abstraction
  - Reuses existing sessiondb infra and prepares for md#253 embeddings storage
  - Plans migrations and pgvector extension validation for PostgreSQL

- **Task #404**: Add configuration management subcommands

  - **`minsky config get <key>`** - Get a configuration value (raw value in CLI; JSON with --json)
  - **`minsky config set <key> <value>`** - Set configuration values programmatically
  - **`minsky config unset <key>`** - Remove configuration values
  - **`minsky config validate`** - Validate configuration against schemas
  - **`minsky config doctor`** - Diagnose common configuration problems
  - Supports nested keys (e.g., `ai.providers.openai.model`)
  - Automatic type detection (boolean, number, JSON objects/arrays)
  - Creates timestamped backups before modifications with `--no-backup` option
  - Validates configuration after changes with rollback on failure
  - Targets user configuration at `~/.config/minsky/config.yaml`
  - Supports both YAML and JSON formats via `--format` option
  - JSON output option for scripting with `--json` flag
  - 59 comprehensive tests with 100% mocked filesystem operations

- **Task #389**: Improve SessionDB migration and plan PostgreSQL cutover

  - Deprecate JSON SessionDB backend with warnings
  - Make dry-run default; backups mandatory (SQLite copy + JSON dump)
  - Remove --connection-string; use config/env for Postgres
  - Add strong preflight validations and --set-default toggle
  - Add backend drift warnings in SessionDB provider

- **Session Cleanup Functionality**: Comprehensive session cleanup implementation that automatically removes old sessions for completed and merged tasks, addressing the gap identified in Task #353. Includes complete filesystem directory removal, **cleanup enabled by default** for merge operations, enhanced session delete commands with comprehensive cleanup, and CLI parameter support with `--skip-cleanup` flag to override default behavior when needed.

- session.edit_file (md#417): Optional `instructions` parameter now supported end-to-end
  - Schema: `instructions` is now optional in MCP `SessionFileEditSchema`
  - Handler: passes `instructions` to `applyEditPattern(original, content, instruction)`
  - CLI: `--instruction` flag is now optional
  - Tests: added integration test verifying instruction-guided placement (e.g., method after constructor)

### Fixed

- **Session PR Merge Error Message**: Improved error message formatting for unapproved PR merge attempts. Removed redundant "Validation error:" prefix for well-formatted validation errors and replaced generic "MERGE REJECTED" with clear, actionable step-by-step guidance. Error messages now detect emoji prefixes to avoid double formatting and provide specific commands users can copy-paste to resolve the issue.
- **Session Branch Cleanup After Merge**: Fixed missing branch cleanup in main workspace after `minsky session pr merge` operations. Following Task #358's approval/merge decoupling, the merge operation now properly cleans up session branches (PR branch and task branch) from the main repository after successful merge, not just session directories. This ensures a clean workspace after completing session workflows.
- **MCP tasks.list Output Format**: Fixed MCP `tasks.list` command returning newline-delimited string instead of structured JSON data. The issue was in the shared command integration where the `json` parameter was being deleted from MCP args, causing `formatResult()` to default to string formatting. Fixed by making shared commands respect the execution context's `format: "json"` setting for proper structured data output in MCP responses.
- **Task Delete Functionality**: Fixed task deletion bug where qualified task IDs (e.g., `md#399`) were not properly handled during deletion operations. The MarkdownTaskBackend now uses the existing `getTaskById` utility function for consistent task ID comparison across all formats, ensuring reliable deletion of tasks regardless of ID format used.
- **GitHub Issues Backend Integration**: Complete integration with repository backend architecture system [Task #357]
- **MCP Tools Command Simplified Output**: Modified `minsky mcp tools` command to output just tool names by default (one per line) for cleaner CLI usage. Added `--json` option to output full JSON response with descriptions and schemas for programmatic access. Maintains backward compatibility while providing more user-friendly default output.
- **Tasks Status No-Op Messaging (md#410)**: `minsky tasks status set` now reports a clear no-op when the new status equals the current status, e.g., `status is already DONE (no change)`, instead of misleading "changed from DONE to DONE".

### Cleanup

- **Test Task Cleanup**: Successfully removed all generic test tasks with names like "Test session for MCP fix verification", "Fix the authentication bug", "Test to see exact MCP error", and other temporary testing tasks. Cleaned up task IDs: md#003, md#377, md#382, md#383, md#399, and their associated spec files. This cleanup improves task list clarity and removes outdated testing artifacts.

### Changed

- **Session Cleanup Default Behavior**: Session cleanup is now enabled by default for merge operations. Users can still disable cleanup with the `--skip-cleanup` flag to preserve session files when needed. This ensures sessions don't accumulate after successful merges while maintaining flexibility for edge cases.

### Enhanced

- **Separation of Concerns**: Proper architectural separation between merge command level (coordinates workflow and triggers cleanup), repository backend level (handles git operations), and session lifecycle level (manages complete session deletion including directories)
- **Clean Architectural Boundaries**: Clear separation maintained between different system components with well-defined responsibilities

### Added

- feat(session.pr.create): Add `--type` (required) and automatic conventional commit title generation. Title must be description-only (no `feat:`, `feat(scope):`). The command auto-detects task ID from session context (or uses provided `--task`) and generates `type(taskId): title`. This is a breaking change: `--type` is now mandatory and prefixed titles are rejected.

- feat(tasks-backend): Implement backend-driven auto-commit/push for Markdown task creation (md#423)
  - Added stash/commit/push/restore flow to `src/domain/tasks/markdownTaskBackend.ts` for both object and spec-file creation paths
  - Commit message format: `chore(task): create <id> <title>`; push attempted with warnings on failure
  - Exposed injectable `gitService` for testability; added unit tests to validate commit/push behavior and no-op when no changes

- tasks: Added three specs to advance embeddings-based context workflow
  - md#445: Implement embedding-based rule suggestion (replace AI-based) reusing tasks embeddings infra
  - md#446: Add cross-cutting reranking support to embeddings infra using Morph reranking API
  - md#447: Extract generic similarity search service with pluggable backends and fallback chain
  - Fixed merge conflict in `process/tasks.md` and deduplicated conflicting md#444/md#446 entries

## md#427: Enforce conventional-commit title validation on session pr edit

- session pr edit now enforces conventional-commit title rules similar to session pr create
- Added optional --type for edit to compose titles from description-only --title
- Validation runs regardless of --no-status-update
- Added tests under tests/integration/session/pr-edit-validation.test.ts and src/adapters/shared/commands/session/pr-subcommand-commands.edit-validation.test.ts

### Fixed

- tasks: `listTasksFromParams` now correctly honors the `status` parameter instead of misusing `filter`, aligning behavior with `tasks list`.

### Added

- tasks search: Added `--status` and `--all` options to filter results by task status, matching `tasks list` semantics. By default, DONE and CLOSED tasks are hidden unless `--all` is provided. Applies to CLI and MCP adapters.
- tasks: Centralized status filtering in `src/domain/tasks/task-filters.ts`; both `TaskService.listTasks` and `tasks search` use the same utility to ensure consistent behavior.