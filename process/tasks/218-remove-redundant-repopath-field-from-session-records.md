# Remove redundant repoPath field from session records

## Status

BACKLOG

## Priority

MEDIUM

## Description

The repoPath field in session records is now redundant after the session-ID-based architecture migration. All sessions resolve to the same standardized path structure (/minsky/sessions/{sessionId}/), making the override mechanism unnecessary.

## Scope
- Remove repoPath field from SessionRecord and Session interfaces
- Update all getRepoPath methods to use calculated paths only
- Remove repoPath handling from session database functions
- Clear existing repoPath values from database during migration
- Update tests to remove repoPath references
- Simplify session storage logic

## Benefits
- Eliminates redundant field that duplicates calculated paths
- Simplifies session data model and interfaces
- Reduces complexity in session storage logic
- Ensures consistent path calculation across all sessions

## Analysis
Current state shows 4 sessions with repoPath values that duplicate the calculated path, and 68 sessions without repoPath that use the calculated path - both produce identical results.

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
