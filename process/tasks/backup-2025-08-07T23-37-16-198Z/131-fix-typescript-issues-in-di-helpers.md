# Fix TypeScript Issues in DI Helpers

## Context

Task 115 successfully delivered practical DI testing patterns, but left some TypeScript linter errors due to iteration limits. These should be cleaned up for a better developer experience.

**Current issues:**

- TypeScript linter errors in `src/utils/test-utils/dependencies.ts`
- Some type inference issues with the new scenario helpers
- Minor type safety improvements needed

## Requirements

1. **Fix TypeScript Errors**

   - [ ] Resolve linter errors in `dependencies.ts`
   - [ ] Improve type safety for scenario helpers
   - [ ] Ensure clean compile with no warnings

2. **Improve Type Inference**

   - [ ] Better return types for `createDepsWithTestTask()`
   - [ ] Better return types for `createDepsWithTestSession()`
   - [ ] Ensure TypeScript can properly infer overrides

3. **Quick Validation**
   - [ ] Run existing tests to ensure no regressions
   - [ ] Verify scenario helpers still work as expected

## Implementation

This is a straightforward cleanup task:

- Fix the TypeScript issues identified in Task 115
- Improve type annotations where needed
- Run tests to ensure everything still works
- Should take 1-2 hours max

## Success Criteria

- [ ] All TypeScript linter errors resolved
- [ ] All existing tests pass
- [ ] New scenario helpers have proper type safety
- [ ] Clean compile with no warnings

## Verification

- [ ] `bun test` passes without errors
- [ ] TypeScript compilation succeeds without warnings
- [ ] Scenario helpers maintain their functionality
