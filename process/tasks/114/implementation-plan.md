# Task #87 Implementation Plan: Unified Session and Repository Resolution

## Overview

This task involves implementing a unified approach to resolve session and repository references, following the concepts and terminology defined in the migration guide. Currently, there are multiple inconsistent approaches to resolving these entities throughout the codebase.

## Analysis of the Current State

1. **Multiple Resolution Strategies**:
   - Different parts of the codebase use different methods to resolve repositories and sessions
   - Inconsistent terminology (mainWorkspace/repoUrl/repoPath/etc.)
   - Lack of clear abstraction between repositories, sessions, and workspaces

2. **Key Files to Modify**:
   - `src/domain/repository.ts`: Contains repository-related types and functions
   - `src/domain/session.ts`: Contains session-related types and functions
   - `src/domain/repo-utils.ts`: Contains utility functions for repository resolution
   - `src/utils/repository-utils.ts`: Contains caching mechanisms for repositories
   - `src/utils/repo.ts`: Wrapper around domain utilities

## Implementation Strategy

### 1. Create New Resolution Functions

1. **Repository Resolution API**
   - Create `resolveRepository(options)` in `src/domain/repository.ts`
   - Support multiple input types (URI, path, session name, auto-detection)
   - Normalize URIs according to the specifications in concepts.md
   - Return a consistent repository object with URI and name

2. **Session Resolution API**
   - Create `resolveSession(options)` in `src/domain/session.ts`
   - Support multiple input types (session name, task ID, auto-detection)
   - Return a consistent session object with workspace path

### 2. Utility Functions

Create helper utilities for:
- URI normalization
- Path conversion
- Validation of repository and session objects
- Error handling for common failure cases

### 3. Implementation Steps (In Order)

1. Implement core URI handling functionality:
   - Create URI normalization functions that handle all formats specified in concepts.md
   - Implement validation functions for each URI type
   - Create utility functions for conversions between formats

2. Implement repository resolution:
   - Create the `resolveRepository` function with support for multiple input types
   - Implement auto-detection logic from the current directory
   - Add clear error messages for failure cases

3. Implement session resolution:
   - Create the `resolveSession` function with support for multiple input types
   - Implement auto-detection logic when in a session directory
   - Add clear error messages for failure cases

4. Write comprehensive tests:
   - Test all repository URI formats
   - Test session resolution from different sources
   - Test error handling
   - Ensure compatibility with existing code

5. Update existing code to use new functions:
   - Replace direct calls to `resolveRepoPath` with `resolveRepository`
   - Replace session path resolution code with `resolveSession`
   - Update type definitions to match new terminology

### 4. Testing Plan

1. **Unit Tests**:
   - Test repository resolution for all URI formats
   - Test session resolution for all input types
   - Test error handling for invalid inputs

2. **Integration Tests**:
   - Test auto-detection in different contexts
   - Test interoperability with existing code
   - Test backward compatibility

3. **Error Case Testing**:
   - Verify clear error messages for all failure modes
   - Test edge cases in path resolution
   - Test invalid URI handling

## Migration Strategy

1. Create new functions alongside existing code
2. Add tests to verify new functions
3. Gradually update call sites to use new functions
4. Maintain backward compatibility during transition
5. Add deprecation warnings to old functions

## Technical Challenges and Decisions

1. **Auto-Detection Logic**: Need to carefully implement auto-detection to work in all contexts
2. **URI Parsing**: Must handle all specified URI formats correctly
3. **Error Handling**: Need to provide clear, actionable error messages
4. **Backward Compatibility**: Must maintain compatibility with existing code
5. **Forward Compatibility**: Design should accommodate future non-local repositories

## Action Items List

1. [ ] Implement URI normalization utilities
2. [ ] Create repository resolution function
3. [ ] Create session resolution function
4. [ ] Write comprehensive tests
5. [ ] Update existing code to use new functions
6. [ ] Document the new resolution strategy
7. [ ] Run all tests to verify correctness
8. [ ] Verify forward compatibility with Task #014

## Timeline

1. Day 1: Implement URI normalization and validation utilities
2. Day 2: Implement repository resolution function
3. Day 3: Implement session resolution function
4. Day 4: Write tests and update existing code
5. Day 5: Final testing, documentation, and PR preparation 

# Implementation Plan for Task #114: Migrate High-Priority Tests to Native Bun Patterns

## Completed Steps

1. [x] Created `process/tasks/114/migration-notes.md` with ongoing documentation
2. [x] Created detailed migration pattern library documenting common patterns between Jest and Bun
3. [x] Added custom assertion helpers in `src/utils/test-utils/assertions.ts`
4. [x] Migrated `src/utils/test-utils/__tests__/enhanced-utils.test.ts`
5. [x] Migrated `src/utils/test-utils/__tests__/assertions.test.ts`
6. [x] Migrated `src/utils/test-utils/__tests__/mocking.test.ts`
7. [x] Migrated `src/utils/filter-messages.test.ts`
8. [x] Migrated `src/domain/__tests__/tasks.test.ts`
9. [x] Created TestGitService utility for simplified git testing
10. [x] Migrated `src/domain/git.test.ts`
11. [x] Updated CHANGELOG.md with progress details
12. [x] Migrated `src/domain/git.pr.test.ts`
13. [x] Migrated `src/domain/session/session-db.test.ts`
14. [x] Added `expectToNotBeNull` helper for inverse null assertions
15. [x] Added mock helpers `expectToHaveBeenCalled` and `getMockCallArg`
16. [x] Migrated `src/adapters/__tests__/shared/commands/rules.test.ts`
17. [x] Migrated `src/adapters/__tests__/shared/commands/tasks.test.ts`
18. [x] Migrated `src/adapters/__tests__/shared/commands/git.test.ts` (found already migrated)
19. [x] Migrated `src/adapters/__tests__/shared/commands/session.test.ts` (found already migrated)
20. [x] Migrated `src/adapters/cli/__tests__/git-merge-pr.test.ts` (found already migrated)
21. [x] Migrated `src/utils/__tests__/param-schemas.test.ts` (found already migrated)
22. [x] Migrated `src/utils/__tests__/option-descriptions.test.ts` (found already migrated)
23. [x] Migrated `src/utils/test-utils/__tests__/compatibility.test.ts` (found already migrated)

## Next Steps

1. [ ] Update high-priority integration tests as needed

## Migration Patterns Established

1. **Use centralized mocking utilities**
   - Prefer `createMock()` from our utilities over direct `mock()`
   - Use `mockModule()` for module-level mocking

2. **Add explicit lifecycle hook imports**
   - Always import `{ beforeEach, afterEach } from "bun:test"`

3. **Use proper ESM imports**
   - Add `.js` extensions to all relative imports

4. **Apply proper mock cleanup**
   - Use `setupTestMocks()` or `mock.restore()` in `afterEach`

5. **Use custom assertion helpers**
   - Apply helpers like `expectToBeInstanceOf()` for missing Jest matchers
   - Use `expectToNotBeNull()` for `expect().not.toBeNull()` assertions
   - Use `expectToHaveBeenCalled()` for checking if a mock was called
   - Use `getMockCallArg()` to safely access mock call arguments

6. **Direct method spying**
   - Use `spyOn(Class.prototype, "methodName")` for clean method mocks
   - Prefer direct method mocking over dependency injection when possible

7. **Proper error handling**
   - Add explicit type annotations in catch blocks: `catch (error: unknown)`
   - Use proper type narrowing with instanceof checks

8. **Direct Method Mocking**
   - When dealing with complex dependencies, consider mocking the method under test directly
   - This approach is cleaner for methods with many internal dependencies
   - Focus on testing the method's contract, not its implementation details

9. **Module Mocking**
   - Use `mock.module()` to mock entire module exports
   - Combine with centralized mock setup in beforeEach
   - Use mock.restore() in afterEach for proper cleanup
   - Particularly useful for utility functions that are imported by tested code

## Progress Metrics

- **Total high-priority tests to migrate**: ~20
- **Tests migrated so far**: 9 (45%)
- **Patterns documented**: 14
- **Custom helpers created**: 9

## Next Priority Files

The next priority for migration is:
1. `src/adapters/__tests__/shared/commands/tasks.test.ts`
2. `src/adapters/__tests__/shared/commands/git.test.ts`

These files test critical business logic in the adapter layer and will help us refine our patterns. 
