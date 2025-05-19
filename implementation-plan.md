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
