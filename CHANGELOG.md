# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- docs(RFC): RFC: Minsky task system transition to backend-SoT with DB overlay; deprecate tasks.md; MCP and sync roadmap
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

- md#429: Import markdown task specs/metadata to DB by default via `minsky tasks migrate` (dry-run; `--execute` to apply)
  - Added `tasks_embeddings` table (HNSW index) to store vectors separately from `tasks`
  - Refactored vector storage to a generic Postgres storage and wired it to `tasks_embeddings`
  - Introduced `TasksImporterService` used by `tasks migrate` (no legacy ID normalization; assumes qualified IDs)
  - Embeddings are populated via existing `minsky tasks index-embeddings`

### Fixed

- session PR CLI: Resolved unresolved merge conflict markers that caused `Unexpected <<` runtime error when running `minsky session pr list`. Cleaned conflicts in `src/domain/session/session-pr-operations.ts`, `src/domain/session/start-session-operations.ts`, `src/domain/session/session-merge-operations.ts`, and `src/domain/session/commands/start-command.ts`. Restored consistent repository backend detection and validation flow.

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
- **Task md#421**: Suppress low-value Octokit HTTP transport logs during `session start` unless `--debug` is enabled. Added concise human-friendly status lines for approval count and branch protection summary before merging. Structured `--json` outputs unchanged.
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
