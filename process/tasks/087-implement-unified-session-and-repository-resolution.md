# Task #087: Implement Unified Session and Repository Resolution

## Context

The codebase currently has multiple approaches to resolving workspaces, repositories, and sessions, creating inconsistency and potential for bugs. Task #080 identified that different strategies are used for similar goals, with no unified approach. This task aims to create a consistent resolution strategy based on the formalized concepts.

## Requirements

1. **Unified Resolution API**

   - Create consistent functions for resolving core entities:
     - `resolveRepository(options)`: Resolves to a repository
     - `resolveSession(options)`: Resolves to a session
   - Support multiple resolution sources:
     - Explicit path/URI specified by user
     - Session name
     - Auto-detection from current directory
     - Task ID

2. **Repository Resolution**

   - Support multiple URI formats:
     - HTTPS URLs (https://github.com/org/repo.git)
     - SSH URLs (git@github.com:org/repo.git)
     - Local paths with file:// schema
     - Plain filesystem paths (automatically converted to file:// URIs)
     - Shorthand notation (org/repo for GitHub repositories)
   - Maintain backward compatibility with existing code
   - Handle repository auto-detection from current directory

3. **Session Resolution**

   - Create a consistent approach to resolving sessions
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

   - [ ] Create `resolveRepository(options)` function
   - [ ] Implement URI normalization and validation
   - [ ] Support multiple URI formats
   - [ ] Add auto-detection from current directory
   - [ ] Add comprehensive JSDoc comments

2. [ ] Update `src/domain/session.ts`:

   - [ ] Create `resolveSession(options)` function
   - [ ] Support resolution from session name, task ID, and current directory
   - [ ] Refactor `isSessionRepository` for clearer detection
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
