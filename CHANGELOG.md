# Changelog

## [Unreleased]

### Fixed
- **Critical Bug**: Resolved task status set backend inconsistency by normalizing task ID format. Tasks were stored with hash format (`#158`) but API called with plain format (`158`), causing `findIndex` to fail. Added ID normalization in `TaskService.updateTaskStatus()` to ensure consistent format matching. This fixes the issue where `minsky tasks status get 158` worked but `minsky tasks status set 158 IN-REVIEW` failed with "Task with ID 158 not found" despite the task existing.

## [2.14.0] - 2024-01-15
