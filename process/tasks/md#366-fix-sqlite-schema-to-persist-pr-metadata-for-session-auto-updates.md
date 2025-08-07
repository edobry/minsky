# Fix SQLite schema to persist PR metadata for session auto-updates

## Context

## Problem

The SQLite database schema is missing the `prState` column, causing `session pr create` to silently fail when storing PR metadata. This breaks the automatic PR update feature implemented in task #365.

## Root Cause Analysis

During task #365 implementation, we discovered that the session auto-update logic works correctly, but PR metadata is never persisted to the database:

1. **TypeScript Interface**: `SessionRecord` in `src/domain/session/session-db.ts` correctly defines `prState?: PullRequestState`
2. **Application Logic**: `src/domain/session/commands/pr-command.ts` attempts to store `prState` via `sessionDb.updateSession()`
3. **Database Schema**: SQLite schema in `src/domain/storage/backends/sqlite-storage.ts` **MISSING** `prState` column entirely
4. **Result**: Silent failure - `updateSession()` succeeds but `prState` data is never stored

## Evidence

### Working Code Attempts to Store PR Data

```typescript
// src/domain/session/commands/pr-command.ts:111-120
await sessionDb.updateSession(resolvedContext.sessionName, {
  ...sessionRecord,
  prState: {
    branchName: result.prBranch,
    commitHash: commitHash,
    lastChecked: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  },
});
```

### Missing Database Column

```sql
-- src/domain/storage/backends/sqlite-storage.ts:92-102
CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY,
  repoName TEXT NOT NULL,
  repoUrl TEXT,
  createdAt TEXT NOT NULL,
  taskId TEXT,
  branch TEXT,
  repoPath TEXT
  -- MISSING: prState column
)
```

### Auto-Update Logic Works Correctly

```typescript
// src/domain/repository/local.ts - correctly detects no PR data
const hasPr = session.pullRequest || (session.prState && session.prState.exists);
if (!hasPr) {
  log.debug(`Session has no associated PR, skipping PR branch update`);
  return; // Correctly skips because prState is undefined
}
```

## Files That Need Updates

### 1. SQLite Schema Migration

- `src/domain/storage/backends/sqlite-storage.ts`
  - Add `prState` column to sessions table
  - Implement migration logic for existing databases

### 2. Drizzle Schema Update

- `src/domain/storage/schemas/session-schema.ts`
  - Add `prState` field to sessions schema for both SQLite and PostgreSQL

### 3. Test Impact

- Verify existing session data is preserved during migration
- Test that `session pr create` now persists `prState` correctly
- Test that `session update` triggers PR auto-updates after PR creation

## Solution Approach

1. **Database Migration**: Add `prState TEXT` column to existing sessions table
2. **Schema Sync**: Update Drizzle schemas to match database structure
3. **Data Validation**: Ensure existing sessions continue working
4. **Integration Test**: Verify complete workflow:
   - `session pr create` → `prState` persisted
   - `session update` → PR branch auto-updated

## Verification Steps

1. Create session and PR: `session pr create`
2. Verify PR data stored: `session get <name> --json` should show `prState`
3. Update session: `session update` should trigger PR branch sync
4. Confirm PR branch has latest changes from main

## Context Links

- **Root Investigation**: Task #365 auto-update implementation
- **Related Feature**: Task #361 automated session sync workflow
- **Database Backend**: SQLite storage implementation
- **PR Workflow**: Session PR creation and management

## Priority

**HIGH** - This blocks the auto-update feature entirely and causes silent data loss during PR creation.

## Requirements

## Solution

## Notes
