# Task #277: Clean up excessive 'as unknown' assertions

## Summary
Clean up hundreds of `as unknown` type assertions throughout the codebase that are masking real TypeScript errors and reducing code quality.

## Background
During Task #276 (test suite optimization), we discovered that the codebase contains hundreds of `as unknown` assertions that are:
1. **Masking real import errors** - Making "Cannot find module" errors invisible
2. **Bypassing TypeScript's type safety** - Making the compiler less effective
3. **Hiding actual bugs** - Real issues become invisible in the noise
4. **Reducing code maintainability** - Making refactoring and debugging harder

## Problem Evidence
TypeScript compilation shows hundreds of errors like:
- `Object is of type 'unknown'` (200+ occurrences)
- `Type 'unknown' is not assignable to type...` (100+ occurrences)
- Real import/syntax errors get buried in this noise

## Goals
1. **Remove excessive `as unknown` assertions** - Replace with proper typing
2. **Restore TypeScript's type safety** - Let the compiler catch real errors
3. **Improve code quality** - Make real issues visible again
4. **Maintain functionality** - Ensure no runtime regressions

## Approach
1. **Systematic audit** - Identify all `as unknown` usage patterns
2. **Categorize by purpose** - Understand why each assertion was added
3. **Replace with proper typing** - Use interfaces, proper generics, etc.
4. **Remove unnecessary assertions** - Where types can be inferred correctly
5. **Test thoroughly** - Ensure no regressions

## Success Criteria
- [ ] Reduce `as unknown` assertions by 80%+
- [ ] TypeScript compilation shows meaningful errors only
- [ ] All tests still pass
- [ ] No runtime functionality regressions
- [ ] Code is more maintainable and debuggable

## Files Most Affected
- `src/domain/storage/backends/` - Heavy usage in database operations
- `src/domain/storage/json-file-storage.ts` - File operations
- `src/domain/storage/monitoring/` - Health monitoring
- Test files - Mock and assertion setup

## Related
- Created from Task #276 analysis
- Blocker for effective TypeScript usage
- Technical debt with high impact on maintainability 
