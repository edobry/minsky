# Implement Unified Session and Repository Resolution

## Context

The codebase currently has multiple approaches to resolving workspaces, repositories, and sessions, creating inconsistency and potential for bugs. Task #080 identified that different strategies are used for similar goals, with no unified approach. Task #086 has now formalized the core concepts and relationships in `src/domain/concepts.md` and provided a migration guide in `src/domain/migration-guide.md`. This task aims to implement the unified resolution strategy described in those documents.

## Requirements

1. **Unified Resolution API**

   - Create consistent functions for resolving core entities as defined in the concepts document:
     - `resolveRepository(options)`: Resolves to a repository with URI and name
     - `resolveSession(options)`: Resolves to a session with workspace path
   - Support multiple resolution sources:
     - Explicit path/URI specified by user
     - Session name
     - Auto-detection from current directory
     - Task ID

2. **Repository Resolution**

   - Implement the URI handling specification from `src/domain/concepts.md` section 4:
     - HTTPS URLs (https://github.com/org/repo.git)
     - SSH URLs (git@github.com:org/repo.git)
     - Local paths with file:// schema
     - Plain filesystem paths (automatically converted to file:// URIs)
     - Shorthand notation (org/repo for GitHub repositories)
   - Implement auto-detection rules from `src/domain/concepts.md` section 5
   - Maintain backward compatibility with existing code

3. **Session Resolution**

   - Create a consistent approach to resolving sessions based on the concepts document
   - Support resolution from:
     - Session name
     - Task ID
     - Current directory (auto-detection)
   - Improve detection of session workspaces

4. **Error Handling**

   - Provide clear, informative error messages
   - Handle edge cases gracefully
   - Validate inputs consistently

5. **Forward Compatibility**
   - Ensure compatibility with Task #014 (Repository Backend Support)
   - Design resolution functions to work with future non-local repositories

## Implementation Steps

1. [ ] Update `src/domain/repository.ts`:

   - [ ] Create `resolveRepository(options)` function following the migration guide
   - [ ] Implement URI normalization and validation as specified in concepts.md
   - [ ] Support multiple URI formats
   - [ ] Add auto-detection from current directory
   - [ ] Add comprehensive JSDoc comments

2. [ ] Update `src/domain/session.ts`:

   - [ ] Create `resolveSession(options)` function following the migration guide
   - [ ] Support resolution from session name, task ID, and current directory
   - [ ] Use the new terminology (`isSessionWorkspace` instead of `isSessionRepository`)
   - [ ] Add comprehensive JSDoc comments

3. [ ] Create utility functions:

   - [ ] URI normalization
   - [ ] Path conversion
   - [ ] Validation helpers

4. [ ] Update tests:

   - [ ] Add tests for `resolveRepository` with all supported formats
   - [ ] Add tests for `resolveSession` with all resolution methods
   - [ ] Add tests for edge cases and error handling

5. [ ] Update existing code to use new resolution functions:
   - [ ] Follow the migration strategy in `src/domain/migration-guide.md`
   - [ ] Identify all places that resolve repositories or sessions
   - [ ] Gradually migrate to the new functions
   - [ ] Maintain backward compatibility

## Verification

- [ ] `resolveRepository` correctly handles all supported URI formats
- [ ] `resolveSession` correctly resolves sessions from all sources
- [ ] Auto-detection works correctly in all supported environments
- [ ] Error messages are clear and informative
- [ ] No regressions in existing functionality
- [ ] All tests pass
- [ ] Forward compatibility with Task #014 is maintained
