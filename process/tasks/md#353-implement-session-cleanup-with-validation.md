# Implement Session Cleanup with Validation

## Status

TODO

## Priority

MEDIUM

## Description

Implement comprehensive session cleanup functionality to automatically remove old sessions for completed and merged tasks. This includes both a standalone cleanup command and automatic cleanup integration with the session approve workflow.

## Problem Statement

As projects grow, session directories accumulate for completed tasks that have been merged into main. These old sessions:

- **Consume disk space**: Old session workspaces take up unnecessary storage
- **Clutter session listings**: Make it harder to find active sessions
- **Create confusion**: Developers might accidentally work in old, stale sessions
- **Reduce performance**: Large numbers of sessions can slow down operations

Currently, there's no automated way to clean up sessions for completed work, requiring manual intervention.

## Requirements

### 1. Session Cleanup Command

**Command Structure Decision**:

- **Current**: `minsky sessiondb` contains database-level operations (migrate, check)
- **Proposed**: Move to `minsky session db cleanup` for logical grouping with session operations
- **Alternative**: Keep as `minsky sessiondb cleanup` for consistency with existing structure

**Core Functionality**:

- **Standalone cleanup command** with comprehensive validation
- **Dry-run capability** to preview what would be cleaned up
- **Configurable retention policies** (age, completion status, merge status)
- **Interactive confirmation** with detailed preview
- **Comprehensive logging** of cleanup actions

**Safety Features**:

- **Multi-level validation** before any deletions
- **Task completion verification** (status = DONE)
- **Merge status verification** (changes merged into main)
- **Workspace state checking** (no uncommitted changes)
- **Backup creation** before cleanup (optional)

### 2. Session Approve Integration

**Automatic Post-Merge Cleanup**:

- **Trigger**: After successful session approve and PR merge
- **Same validation logic** as standalone command
- **User consent required** (configurable default behavior)
- **Graceful failure handling** (cleanup failure doesn't break approve)

**Configuration Options**:

- **Auto-cleanup enabled/disabled** (default: prompt user)
- **Retention period** (e.g., keep sessions for N days after merge)
- **Validation strictness level** (strict, normal, permissive)

### 3. Validation Logic (Shared)

**Session Eligibility Criteria**:

```typescript
interface CleanupEligibility {
  taskStatus: "DONE" | "OTHER";
  mergeStatus: "MERGED" | "NOT_MERGED" | "UNKNOWN";
  workspaceClean: boolean;
  ageInDays: number;
  hasUncommittedChanges: boolean;
  branchExists: boolean;
  sessionActive: boolean;
}
```

**Safety Checks**:

1. **Task Status Verification**:

   - Task must be marked as DONE in task management system
   - Task must exist and be trackable

2. **Git Merge Verification**:

   - Session branch changes must be merged into main
   - No pending commits or unmerged work
   - Branch can be safely deleted (optional)

3. **Workspace State Verification**:

   - No uncommitted changes in session workspace
   - No stash entries that would be lost
   - No important local-only work

4. **Age and Activity Verification**:
   - Session last activity beyond minimum retention period
   - No recent access (configurable threshold)
   - Not currently in use by any process

### 4. Command Specifications

#### `minsky session db cleanup` (or `minsky sessiondb cleanup`)

**Parameters**:

```bash
minsky session db cleanup [options]

Options:
  --dry-run, -n           Show what would be cleaned up without doing it
  --task <task-id>        Clean up sessions for specific task only
  --older-than <days>     Only clean sessions older than N days (default: 7)
  --force                 Skip interactive confirmation
  --backup-dir <path>     Create backups before deletion
  --include-active        Include sessions that might be active (dangerous)
  --validation-level      strict|normal|permissive (default: strict)
  --json                  Output results in JSON format
```

**Example Usage**:

```bash
# Safe dry-run to see what would be cleaned
minsky session db cleanup --dry-run

# Clean sessions older than 30 days with backup
minsky session db cleanup --older-than 30 --backup-dir ./session-backups

# Clean specific task's sessions
minsky session db cleanup --task 123 --dry-run

# Force cleanup with minimal validation (dangerous)
minsky session db cleanup --force --validation-level permissive
```

#### Session Approve Integration

**New Parameters for `minsky session approve`**:

```bash
minsky session approve [existing-options] [cleanup-options]

Additional Options:
  --cleanup                    Enable cleanup after successful merge
  --no-cleanup                 Disable cleanup after merge
  --cleanup-retention <days>   Keep session for N days after merge (default: 0)
```

**Workflow Integration**:

1. Complete existing approve workflow
2. If approve successful and cleanup enabled:
   - Run same validation as cleanup command
   - Prompt user for confirmation (unless configured otherwise)
   - Perform cleanup with full logging
   - Report cleanup results

### 5. Implementation Architecture

**Shared Validation Service**:

```typescript
// src/domain/session/session-cleanup-validator.ts
export class SessionCleanupValidator {
  async validateSessionForCleanup(sessionId: string): Promise<CleanupEligibility>;
  async getCleanupCandidates(criteria: CleanupCriteria): Promise<CleanupCandidate[]>;
  async performSafeCleanup(
    candidates: CleanupCandidate[],
    options: CleanupOptions
  ): Promise<CleanupResult>;
}
```

**Command Implementations**:

- `src/adapters/shared/commands/session-cleanup.ts` - Standalone command
- `src/domain/session/session-approve-operations.ts` - Integration with approve workflow

**Configuration Support**:

- Global defaults in user config
- Repository-specific overrides in `.minsky/config.toml`
- Command-line parameter overrides

### 6. Safety and Recovery

**Backup Strategy**:

- **Optional backup creation** before any cleanup
- **Metadata preservation** (session info, task associations)
- **Restore capability** from backups

**Error Handling**:

- **Graceful degradation** (partial cleanup on errors)
- **Detailed error reporting** with recovery suggestions
- **Rollback capability** for failed operations

**Audit Trail**:

- **Comprehensive logging** of all cleanup actions
- **Before/after session counts** and disk space freed
- **Validation results** and decisions made

## Acceptance Criteria

### Phase 1: Core Infrastructure

- [ ] **SessionCleanupValidator service** implemented with comprehensive validation
- [ ] **Shared validation logic** working for both command and approve integration
- [ ] **Configuration system** supporting global and repo-specific settings
- [ ] **Unit tests** for validation logic (90%+ coverage)

### Phase 2: Standalone Command

- [ ] **Cleanup command implemented** with all specified parameters
- [ ] **Dry-run functionality** showing accurate preview
- [ ] **Interactive confirmation** with detailed session information
- [ ] **Backup capability** working correctly
- [ ] **Integration tests** for command functionality

### Phase 3: Session Approve Integration

- [ ] **Post-merge cleanup** integrated into approve workflow
- [ ] **User consent handling** (prompt/auto/disabled modes)
- [ ] **Graceful error handling** (cleanup failure doesn't break approve)
- [ ] **Configuration options** working in session approve
- [ ] **End-to-end tests** for approve + cleanup workflow

### Phase 4: Production Readiness

- [ ] **Command structure decision** finalized (`session db` vs `sessiondb`)
- [ ] **Documentation updated** with cleanup functionality
- [ ] **Error messages** clear and actionable
- [ ] **Performance testing** with large numbers of sessions
- [ ] **Security review** completed (file system operations)

## Implementation Notes

### Command Structure Decision

**Option A: `minsky session db cleanup`**

- **Pros**: Logical grouping with session operations, better discoverability
- **Cons**: Requires refactoring existing sessiondb commands
- **Impact**: Breaking change for existing sessiondb users

**Option B: `minsky sessiondb cleanup`**

- **Pros**: Consistent with existing structure, no breaking changes
- **Cons**: Less intuitive grouping, sessiondb becomes overloaded
- **Impact**: Minimal change required

**Recommendation**: Start with Option B for immediate implementation, consider Option A as future refactoring.

### Integration Strategy

**Session Approve Workflow**:

1. Existing approve logic completes successfully
2. Check if cleanup is enabled (config + command flags)
3. Run cleanup validation in background
4. Present results to user with recommendation
5. Execute cleanup if confirmed
6. Report results and continue

**Error Isolation**:

- Cleanup errors should NOT fail the approve operation
- Cleanup should be clearly separated from core approve functionality
- User should get clear feedback on cleanup success/failure

### Validation Complexity

**Strict Mode** (default):

- All safety checks must pass
- Require explicit confirmation for any edge cases
- Conservative approach to prevent data loss

**Normal Mode**:

- Allow some edge cases with warnings
- Reasonable defaults for common scenarios
- Balance safety with usability

**Permissive Mode**:

- Minimal validation, maximum automation
- For advanced users who understand risks
- Require explicit flag to enable

## Dependencies

- Task management system integration (task status checking)
- Git service for merge status verification
- File system operations for workspace cleanup
- Configuration system for user preferences
- Session database for session metadata

## Risk Assessment

**High Risk**:

- **Data loss**: Accidental deletion of important work
- **Mitigation**: Multiple validation layers, dry-run capability, backup options

**Medium Risk**:

- **Performance impact**: Cleanup operations on large session sets
- **Mitigation**: Background processing, progress reporting, cancellation support

**Low Risk**:

- **Configuration complexity**: Too many options confusing users
- **Mitigation**: Sensible defaults, clear documentation, progressive disclosure

## Future Enhancements

- **Scheduled cleanup**: Automated cleanup on schedule (cron-like)
- **Smart retention**: ML-based prediction of session importance
- **Cloud integration**: Archive old sessions to cloud storage instead of deletion
- **Team coordination**: Respect other team members' sessions in shared environments
