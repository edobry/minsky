# Task #002: Store Session Repos Under Per-Repo Directories and Add repoName to Session DB

## Context

Currently, session repositories are stored in a flat directory structure and the session DB does not explicitly record the normalized repo name. To improve organization, traceability, and future scalability, session repos should be grouped under per-repo directories using a normalized repo name (e.g., `org/project` for remotes, `local/project` for local paths). The session DB should also include this normalized repo name for each session.

## Requirements

1. **SessionRecord Update**
   - Add a `repoName` field (string, e.g., `org/project` or `local/project`) to `SessionRecord` in `src/domain/session.ts`.

2. **Repo Name Normalization**
   - For remote URLs:
     - Extract the org and project (e.g., `github.com/org/project.git` → `org/project`).
     - Strip `.git` if present.
   - For local paths:
     - Use `local/<basename-of-path>` (e.g., `/Users/edobry/Projects/minsky` → `local/minsky`).

3. **Directory Structure**
   - Store session repos under:
     ```
     $XDG_STATE_HOME/minsky/git/<repoName>/<session>
     ```
     Example:
     - `.../minsky/git/org/project/test-session-1`
     - `.../minsky/git/local/minsky/test-session-2`

4. **Session DB Migration**
   - On next run, migrate any existing session records to include the new `repoName` field and update their workdir if needed.
   - No need for backward compatibility with the old structure.

5. **Update All Logic**
   - All session creation, lookup, and path resolution must use the new per-repo directory structure and `repoName` field.

6. **Testing**
   - Ensure all commands (start, cd, branch, pr, etc.) work with the new structure.
   - Add/modify tests to verify correct repo grouping and DB schema.

7. **Documentation**
   - Update documentation to describe the new session storage and DB schema.

## Implementation Steps

1. Update the `SessionRecord` type in `src/domain/session.ts` to include a `repoName` field.
2. Implement a utility function to normalize repo URLs/paths into the required format.
3. Update `GitService` and all session-related logic to use the new directory structure.
4. On startup or session creation, migrate any existing session records to the new format.
5. Update all commands and utilities that resolve session paths to use the new structure.
6. Update/add tests for the new logic.
7. Update documentation and CLI help output.

## Verification

- [x] Session DB entries include the correct `repoName` for each session.
- [x] Session repos are stored under the correct per-repo directory structure.
- [x] All session-related commands work with the new structure.
- [x] Existing session records are migrated to the new format.
- [x] All relevant tests pass.
- [x] Documentation and CLI help are updated.

## Work Log
- 2025-04-29: Added `repoName` field to `SessionRecord` interface
- 2025-04-29: Implemented `normalizeRepoName` utility function with tests
- 2025-04-29: Updated `GitService` to use per-repo directory structure
- 2025-04-29: Added migration logic for existing session records
- 2025-04-29: Updated tests to verify new directory structure
- 2025-04-29: Updated changelog with changes
- 2025-04-30: Enhanced directory structure to use sessions subdirectory with backward compatibility

## Notes

- For remote URLs, parse and extract the org and project, stripping `.git` if present.
- For local paths, use `local/<basename>`.
- No need to support the old structure after migration. 
