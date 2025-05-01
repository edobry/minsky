# Task #021: Refactor Large Methods in GitService

## Description

Based on codebase analysis, the `GitService` class contains excessively large methods that need refactoring for better maintainability. The `prWithDependencies` method in particular is approximately 248 lines long, making it difficult to understand, test, and maintain.

## Requirements

1. Refactor the `prWithDependencies` method in `src/domain/git.ts` into smaller, focused functions:
   - Extract branch determination logic into a separate method
   - Extract base branch detection logic into its own method
   - Extract PR content generation into a discrete method
   - Ensure all extracted methods have proper error handling

2. Maintain full test coverage during refactoring
   - All existing tests must continue to pass
   - Add targeted tests for newly extracted methods

3. Follow domain-oriented-modules principles:
   - Keep related functions together
   - Avoid creating cross-module dependencies
   - Organize code by what it operates on

## Success Criteria

- The `prWithDependencies` method is reduced to less than 50 lines
- All extracted methods have clear, specific responsibilities
- All tests pass with no regressions
- Code is more maintainable with lower cognitive complexity

## Notes

This refactoring will make the codebase more maintainable and easier to understand for new contributors. It will also make the GitService more testable by enabling more focused unit tests for the extracted methods.

## Related Files

- src/domain/git.ts
- src/domain/git.test.ts
- src/domain/git.pr.test.ts 
