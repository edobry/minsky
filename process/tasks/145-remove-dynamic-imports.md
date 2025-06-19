# Task #145: Remove Dynamic Imports

## Context

Replace all dynamic imports with static imports throughout the codebase, following the `no-dynamic-imports` rule. This task addresses the issue identified where dynamic imports are used in various files, particularly in the GitHub backend implementation.

## Requirements

1. Replace all dynamic imports with static imports in the following files:
   - `src/domain/git.ts` (2 instances)
   - `src/domain/session.ts` (1 instance)
   - `src/domain/uri-utils.ts` (1 instance)
   - `src/domain/repository/index.ts` (7 instances)
   - `src/domain/repository.ts` (11 instances)
   - `src/domain/tasks/githubBackendFactory.ts` (2 instances)
   - `src/domain/tasks/taskService.ts` (2 instances)
   - Other files with dynamic imports (excluding justified exceptions)

2. Ensure all imports use the `.js` extension for relative imports (as required by ESM)

3. Update import organization following project conventions

4. Verify that all tests pass after the changes

5. Ensure no TypeScript compilation errors

## Implementation Steps

1. [ ] Start with leaf modules (those with no circular dependencies)
2. [ ] Work up to modules with circular dependencies
3. [ ] Refactor circular dependencies where needed
4. [ ] Test each module after changes
5. [ ] Run full test suite at the end

## Verification

- [ ] All dynamic imports are replaced with static imports (except justified exceptions)
- [ ] All imports use proper `.js` extensions for relative imports
- [ ] All tests pass
- [ ] No TypeScript compilation errors
- [ ] No linter warnings related to imports
- [ ] Code follows existing import organization patterns 
