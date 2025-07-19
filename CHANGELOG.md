# Changelog

## [Unreleased]

### Fixed
- **Critical Bug**: Resolved task status set backend inconsistency through systematic task ID format migration and proper normalization. Completed the architectural separation where storage uses plain format (`"295"`) and display uses hash format (`"#295"`). Applied comprehensive migration to session database with backups. Implemented transition-period handling using `normalizeTaskIdForStorage()` utility to support both legacy hash and new plain formats. This fixes the issue where `minsky tasks status get 158` worked but `minsky tasks status set 158 IN-REVIEW` failed with "Task with ID 158 not found" despite the task existing.

### Added
- **Task ID Migration**: Completed migration script execution with backup support for converting hash format to plain storage format
- **Transition Period Support**: Added robust handling of mixed storage formats during migration period

## [2.14.0] - 2024-01-15
