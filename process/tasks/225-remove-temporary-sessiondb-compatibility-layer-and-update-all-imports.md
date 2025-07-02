# Remove temporary SessionDB compatibility layer and update all imports

## Status

BACKLOG

## Priority

MEDIUM

## Description

Follow up to task #219: Remove the temporary SessionDB compatibility class and update all remaining direct SessionDB imports to use createSessionProvider() and proper interfaces.

## Background
After removing the legacy SessionDB class in task #219, we added a temporary compatibility layer to prevent import errors. This task should clean up that temporary solution.

## Tasks
- [ ] Update all files that import SessionDB directly to use createSessionProvider()
- [ ] Update type annotations to use SessionProviderInterface instead of SessionDB
- [ ] Remove the temporary SessionDB compatibility class from session.ts
- [ ] Verify all imports work correctly after removal
- [ ] Test that all CLI commands still function properly

## Files to Update
Based on grep search, these files still have direct SessionDB imports:
- src/domain/localGitBackend.ts (partially fixed)
- src/domain/workspace.ts (partially fixed) 
- src/domain/remoteGitBackend.ts (partially fixed)
- src/domain/repository.ts (has dynamic imports)
- src/domain/repository/local.ts
- src/domain/repository/remote.ts  
- src/domain/repository/github.ts
- src/domain/repo-utils.ts
- src/adapters/mcp/session-files.ts
- src/adapters/mcp/session-workspace.ts

## Verification
- [ ] Run full test suite
- [ ] Test basic CLI commands: minsky tasks list, minsky session list, etc.
- [ ] Confirm no 'SessionDB not found' errors

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
