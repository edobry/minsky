# Fix inconsistent repository name normalization between SessionDB and GitService

## Context

Currently, there's an inconsistency in how repository paths are normalized between SessionDB and GitService:

- The URI normalization in repository-uri.ts creates paths with slashes (e.g., "local/minsky")
- GitService does additional normalization to replace slashes with dashes (e.g., "local-minsky")

This inconsistency causes problems with session directory creation and path resolution, where the database may store one format while the file system uses another. The current workaround in SessionDB.getRepoPath handles both formats, but a more consistent approach is needed.

## Requirements

1. Align the normalization logic between SessionDB and GitService to consistently handle repository names
2. Ensure that repository paths with slashes (e.g., "local/minsky") are preserved rather than converted to dashes
3. Update the GitService.getSessionWorkdir method to handle repository names consistently with SessionDB
4. Update the GitService.clone method to maintain path format consistency with SessionDB
5. Add comprehensive tests to verify consistent path handling
6. Implement this change in a way that doesn't break existing repositories

## Implementation Steps

1. [ ] Analyze the current normalization in GitService.getSessionWorkdir
2. [ ] Modify GitService.getSessionWorkdir to preserve slashes in repository names
3. [ ] Update GitService.clone to maintain path format consistency with SessionDB
4. [ ] Add backward compatibility to handle both path formats
5. [ ] Add tests to verify paths are consistent between components
6. [ ] Update documentation to clarify path normalization behavior

## Verification

- [ ] GitService preserves slashes in repository names
- [ ] Session directories are created with consistent naming
- [ ] Both SessionDB and GitService use the same path format for the same repository
- [ ] Existing repositories can still be accessed
- [ ] Tests pass and verify that paths are consistent between components
