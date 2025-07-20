# Changelog

## [Unreleased]

### Fixed
- **Session Start Bug**: Fixed `minsky session start --description` command failing with "createTaskFromTitleAndDescription is not a function" error. Added the missing method to TaskService class, TaskBackend interface, and JsonFileTaskBackend implementation. The auto-task creation workflow now works correctly.
- **Critical Bug**: Resolved task status set backend inconsistency through systematic task ID format migration and proper normalization. Completed the architectural separation where storage uses plain format (`"295"`) and display uses hash format (`"#295"`). Applied comprehensive migration to session database with backups. Implemented transition-period handling using `normalizeTaskIdForStorage()` utility to support both legacy hash and new plain formats. This fixes the issue where `minsky tasks status get 158` worked but `minsky tasks status set 158 IN-REVIEW` failed with "Task with ID 158 not found" despite the task existing.
- **Critical Architecture Fix (#304)**: Resolved special workspace auto-commit sync issue by fixing TaskBackendRouter architecture violation. The `categorizeMarkdownBackend()` method was conditionally using current workspace instead of always enforcing special workspace usage for markdown backends. This broke auto-commit functionality and caused test failures with infinite loops (700+ billion milliseconds). Fixed by enforcing consistent special workspace routing and implementing proper test isolation. Results: 75% reduction in test failures (16→4), eliminated infinite loops, restored auto-commit sync functionality.

### Added
- **Task ID Migration**: Completed migration script execution with backup support for converting hash format to plain storage format across all systems
- **Auto-Commit Integration**: Enhanced task operations to automatically commit and push changes when using markdown backend in special workspace environment
- **Architecture Compliance**: All markdown backend operations now consistently use special workspace regardless of current directory or local file presence

## [2.14.0] - 2024-01-15
