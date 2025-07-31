# Implement Session Outdated Detection and Display

## Context

## Summary

Implement a detection mechanism to identify when sessions become outdated after PR merges to main, similar to GitHub's outdated PR banner. Display this status in session commands and provide tools to list all outdated sessions.

## Context & Dependencies

### Prerequisites

- **Existing session management**: Current session workflow and data structures
- **Git integration**: Ability to detect main branch changes and timestamps
- **Session storage**: Backend capability to store session metadata

### Building Toward

This provides an immediate solution for session maintenance awareness while serving as a foundation for the more advanced automated sync system described in Task #360.

## Problem Statement

When PRs are merged to `main`, active sessions become outdated but there's no easy way to:

1. **Identify which sessions are outdated** without manual git comparisons
2. **See outdated status** when viewing session details
3. **Get an overview** of all sessions that need attention
4. **Understand the recency** of when sessions became outdated

This creates manual overhead and increases the likelihood of merge conflicts when sessions are eventually merged.

## Proposed Solution: Session Outdated Detection

### 1. Data Model Extensions

#### 1.1 Extend Session Data with Sync Tracking

```typescript
interface SessionData {
  // ... existing session fields
  
  syncStatus?: {
    lastMainSync?: string;           // Last commit hash from main that was synced
    lastMainSyncTimestamp?: Date;    // When that sync occurred
    lastUpdateTimestamp?: Date;      // When session was last updated
    isOutdated?: boolean;           // Computed field: main has newer commits
    mainCommitsBehind?: number;     // How many commits behind main
    lastChecked?: Date;             // When sync status was last calculated
  };
}
```

#### 1.2 Sync Status Computation

```typescript
interface SyncStatusInfo {
  isOutdated: boolean;
  commitsBehind: number;
  lastMainCommit: string;
  lastMainCommitDate: Date;
  sessionLastUpdate: Date;
  daysBehind: number;
  severity: "current" | "stale" | "very-stale" | "ancient";
}

// Severity thresholds
const STALE_THRESHOLD_DAYS = 3;
const VERY_STALE_THRESHOLD_DAYS = 7;
const ANCIENT_THRESHOLD_DAYS = 14;
```

### 2. Detection Mechanisms

#### 2.1 Timestamp-Based Detection (Simple)

```typescript
async function computeSyncStatus(sessionId: string): Promise<SyncStatusInfo> {
  const session = await sessionService.getSession(sessionId);
  const mainBranch = await gitService.getMainBranch();
  
  // Get latest main commit
  const latestMainCommit = await gitService.getLatestCommit(mainBranch);
  const latestMainDate = await gitService.getCommitDate(latestMainCommit.hash);
  
  // Compare with session's last update
  const sessionLastUpdate = session.syncStatus?.lastUpdateTimestamp || session.createdAt;
  
  const isOutdated = latestMainDate > sessionLastUpdate;
  const daysBehind = Math.floor((Date.now() - latestMainDate.getTime()) / (1000 * 60 * 60 * 24));
  
  return {
    isOutdated,
    commitsBehind: isOutdated ? await gitService.getCommitsBetween(sessionLastUpdate, latestMainDate) : 0,
    lastMainCommit: latestMainCommit.hash,
    lastMainCommitDate: latestMainDate,
    sessionLastUpdate,
    daysBehind,
    severity: computeSeverity(daysBehind, isOutdated)
  };
}
```

#### 2.2 Commit-Based Detection (More Accurate)

```typescript
async function computeDetailedSyncStatus(sessionId: string): Promise<SyncStatusInfo> {
  const session = await sessionService.getSession(sessionId);
  const sessionBranch = await gitService.getSessionBranch(sessionId);
  const mainBranch = await gitService.getMainBranch();
  
  // Get merge base and check if main has moved ahead
  const mergeBase = await gitService.getMergeBase(sessionBranch, mainBranch);
  const latestMainCommit = await gitService.getLatestCommit(mainBranch);
  
  const isOutdated = mergeBase !== latestMainCommit.hash;
  const commitsBehind = isOutdated ? 
    await gitService.getCommitCount(`${mergeBase}..${mainBranch}`) : 0;
  
  return {
    isOutdated,
    commitsBehind,
    lastMainCommit: latestMainCommit.hash,
    lastMainCommitDate: await gitService.getCommitDate(latestMainCommit.hash),
    sessionLastUpdate: session.updatedAt,
    daysBehind: Math.floor((Date.now() - latestMainCommit.timestamp) / (1000 * 60 * 60 * 24)),
    severity: computeSeverity(commitsBehind, isOutdated)
  };
}
```

### 3. CLI Command Enhancements

#### 3.1 Enhanced Session Get Command

```bash
# Show outdated status in session details
minsky session get <session-id>
# Output:
# Session: feature-authentication
# Status: ACTIVE
# Branch: session/feature-authentication
# Task: #123: Implement user authentication
# 
# ⚠️  OUTDATED: 5 commits behind main (3 days old)
# Last main sync: abc1234 (2024-01-15)
# Last updated: 2024-01-12
# Severity: STALE
#
# Recent main changes:
# - def5678: Fix security vulnerability (2024-01-16)
# - ghi9012: Update dependencies (2024-01-15)
# - jkl3456: Add rate limiting (2024-01-15)
```

#### 3.2 New Outdated Sessions Command

```bash
# List all outdated sessions
minsky session outdated [--severity current|stale|very-stale|ancient] [--sort commits|days]
# Output:
# Outdated Sessions (3 found):
# 
# 🔴 session-456: Feature Work [VERY STALE]
#    └─ 12 commits behind, 8 days old
# 🟡 session-789: Bug Fix [STALE] 
#    └─ 5 commits behind, 4 days old
# 🟡 session-123: Refactor [STALE]
#    └─ 3 commits behind, 2 days old
#
# Run 'minsky session sync <id>' to update a session
# Run 'minsky session outdated --help' for more options
```

#### 3.3 Enhanced Session List Command

```bash
# Show sync status in session listing
minsky session list --show-sync-status
# Output:
# Active Sessions:
# - session-123: Feature Work [ACTIVE] ⚠️ 3 commits behind
# - session-456: Bug Fix [ACTIVE] ✅ up to date  
# - session-789: Refactor [ACTIVE] 🔴 12 commits behind (ancient)
```

#### 3.4 Batch Status Check Command

```bash
# Check sync status for all sessions (updates cached status)
minsky session check-sync [--update-cache] [--verbose]

# Show summary of sync status across all sessions
minsky session sync-summary
# Output:
# Session Sync Summary:
# ✅ Up to date: 2 sessions
# 🟡 Stale (3-7 days): 1 session  
# 🔴 Very stale (7+ days): 1 session
# 
# Use 'minsky session outdated' for details
```

### 4. Backend Implementation

#### 4.1 Git Service Extensions

```typescript
interface GitService {
  // ... existing methods
  
  // Sync status detection
  getLatestMainCommit(): Promise<GitCommit>;
  getMergeBase(branch1: string, branch2: string): Promise<string>;
  getCommitsBetween(fromRef: string, toRef: string): Promise<GitCommit[]>;
  getCommitCount(range: string): Promise<number>;
  
  // Commit information
  getCommitDate(commitHash: string): Promise<Date>;
  getCommitsSince(since: Date, branch?: string): Promise<GitCommit[]>;
}
```

#### 4.2 Session Service Extensions

```typescript
interface SessionService {
  // ... existing methods
  
  // Sync status management
  updateSyncStatus(sessionId: string, status: SyncStatusInfo): Promise<void>;
  getSyncStatus(sessionId: string): Promise<SyncStatusInfo>;
  getOutdatedSessions(severity?: SyncSeverity): Promise<SessionData[]>;
  
  // Batch operations
  refreshAllSyncStatuses(): Promise<void>;
  getSyncSummary(): Promise<SyncSummary>;
}
```

### 5. Implementation Plan

#### Phase 1: Core Detection

- [ ] Extend session data model with sync status fields
- [ ] Implement basic timestamp-based sync status detection
- [ ] Add git service methods for commit comparison
- [ ] Create sync status computation functions

#### Phase 2: CLI Integration

- [ ] Add sync status display to `session get` command
- [ ] Implement `session outdated` command
- [ ] Add `--show-sync-status` flag to `session list`
- [ ] Create `session check-sync` command

#### Phase 3: Enhanced Detection

- [ ] Implement commit-based detection for accuracy
- [ ] Add severity classification system
- [ ] Create batch sync status operations
- [ ] Add caching and performance optimizations

#### Phase 4: UX Polish

- [ ] Add visual indicators and color coding
- [ ] Implement detailed outdated session information
- [ ] Add help text and action suggestions
- [ ] Create sync summary and reporting features

## Success Criteria

### Functional Requirements

- [ ] Users can see if a session is outdated when viewing session details
- [ ] `session outdated` command lists all outdated sessions with clear severity indicators
- [ ] Sync status is computed efficiently without significant performance impact
- [ ] Outdated sessions show helpful information about what they're missing

### Technical Requirements

- [ ] Sync status computation is accurate and reliable
- [ ] Git operations are optimized to minimize performance impact
- [ ] Status information is cached appropriately to avoid repeated computations
- [ ] Backend abstraction supports different storage mechanisms

### User Experience Requirements

- [ ] Clear visual indicators for different levels of "outdatedness"
- [ ] Helpful information about recent main changes affecting sessions
- [ ] Easy workflow for identifying and addressing outdated sessions
- [ ] Integration with existing session management commands

## Future Integration

This interim solution provides the foundation for:

- **Task #360**: Advanced automated sync workflow
- **AI integration**: Intelligent analysis of which changes affect which sessions
- **Notification system**: Proactive alerts about critical outdated sessions
- **Automated sync**: Optional automatic syncing for low-risk scenarios 


## Requirements

## Solution

## Notes
