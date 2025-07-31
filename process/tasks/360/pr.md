## Summary

This PR implements a comprehensive session outdated detection and display system for Minsky CLI, providing users with visibility into when their development sessions fall behind the main branch. The system tracks both timestamp-based and commit-based outdated status with severity levels and visual indicators.

## Changes

### Added

**Data Model Extensions:**
- New `SyncSeverity` type with levels: `current`, `stale`, `very-stale`, `ancient`
- `SyncStatus` interface for basic sync tracking (timestamps, commit counts, flags)
- `SyncStatusInfo` interface for detailed computed status information
- `GitCommit` interface for structured commit data
- Extended `SessionRecord` and `Session` with optional `syncStatus` field

**Git Service Methods:**
- `getLatestMainCommit()` - Get the latest commit from main branch
- `getMergeBase()` - Find merge base between two branches
- `getCommitsBetween()` - Get commits in a range
- `getCommitCount()` - Count commits in a range
- `getCommitDate()` - Get commit timestamp
- `getCommitsSince()` - Get commits since a date
- `getMainBranch()` - Detect main/master branch automatically

**Core Sync Status Logic:**
- `computeSyncStatus()` - Calculate detailed sync status using both timestamp and commit-based detection
- `computeSeverity()` - Classify outdatedness into severity levels
- `formatSyncStatus()` - Generate human-readable status strings
- `getRecentMainChanges()` - Fetch recent commits from main for outdated sessions

**New CLI Commands:**
- `minsky session outdated` - List all outdated sessions with filtering and sorting
- `minsky session check-sync` - Batch sync status checking with cache updates
- `minsky session sync-summary` - Quick overview of sync status across all sessions

### Changed

**Enhanced Existing Commands:**
- `minsky session get` - Now displays comprehensive sync status with visual indicators
- `minsky session list --show-sync-status` - Shows inline sync status indicators

**CLI Integration:**
- Extended command parameter schemas for new sync-related options
- Added command classes and factory functions for new commands
- Enhanced result formatters with visual severity indicators (🔴🟠🟡✅)
- Improved session display with detailed sync information and recent changes

## Features

### Severity Levels and Thresholds
- **Current**: Up to date with main branch
- **Stale**: 3+ days behind main
- **Very Stale**: 7+ days behind main
- **Ancient**: 14+ days behind main

### Visual Indicators
- 🔴 Ancient (14+ days behind)
- 🟠 Very stale (7+ days behind)
- 🟡 Stale (3+ days behind)
- ✅ Current (up to date)

### Detection Mechanisms
- **Timestamp-based**: Compares session last update with main branch commits
- **Commit-based**: Uses Git merge base to count commits behind main
- **Graceful degradation**: Falls back to basic detection if advanced Git operations fail

### User Experience
- Detailed sync status in `session get` including recent main changes
- Quick overview in `session list --show-sync-status`
- Filterable and sortable outdated session listing
- Batch sync checking with error handling and progress reporting
- Summary statistics across all sessions

## Testing

- All new functionality includes comprehensive error handling
- Git operations gracefully handle missing repositories or branches
- Session sync status computation continues even if individual sessions fail
- CLI commands provide meaningful error messages and verbose output options

## Implementation Details

The system is built with dependency injection for testability and follows the existing Minsky architecture patterns:

- **Domain Layer**: Core sync status logic in `sync-status-service.ts`
- **Adapter Layer**: CLI command integration and formatting
- **Service Layer**: Extended Git operations for commit analysis
- **Interface Layer**: Extended session and Git service interfaces

This implementation provides the foundation for future automation workflows (Task #361) while delivering immediate value to users who need visibility into session outdated status.

## Checklist

- [x] All requirements implemented per task specification
- [x] Data model extensions completed
- [x] Git service methods implemented
- [x] Core sync status logic implemented
- [x] CLI commands enhanced and new commands added
- [x] Visual indicators and formatting implemented
- [x] Error handling and graceful degradation
- [x] Code quality standards met (linting passed)
- [x] CHANGELOG.md updated with implementation details
- [x] Foundation established for future automation workflows
