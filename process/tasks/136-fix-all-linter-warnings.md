# Fix All Linter Warnings

## Summary

Fix all ESLint warnings and errors across the codebase. There are currently **1,393 problems (395 errors, 998 warnings)** with **395 errors**.

## Background

The codebase has accumulated significant linting issues that need systematic resolution. The linter output shows various categories of problems that require both automated fixes and manual intervention.

## Current Progress

### Phase 1: Automated Fixes - ❌ NOT EFFECTIVE

- [x] Run `bun run lint:fix` to automatically fix all auto-fixable issues
- [x] Verify that automated fixes don't break functionality
- [x] Commit automated fixes as a single logical change
- **Result**: Automated fixes were not effective due to custom rule violations requiring manual intervention

### Phase 2: Manual Fixes by Category - 🚧 IN PROGRESS

#### 1. Console Statement Issues (High Priority - ~120+ instances) - 🚧 WORKING

**Rule:** `no-console`, `no-restricted-properties`
**Issue:** Direct console._ usage instead of logger
**Fix:** Replace with appropriate log._ methods:

- `console.log` → `log.cli()` (user-facing) or `log.debug()` (debugging)
- `console.error` → `log.error()` (internal) or `log.cliError()` (user-facing)
- `console.warn` → `log.warn()` (internal) or `log.cliWarn()` (user-facing)

**Files to fix:**

- `src/test-migration/commands/analyze.ts` - ~14 console statements
- `src/test-migration/commands/batch.ts` - ~28 console statements
- `src/test-migration/commands/migrate.ts` - ~18 console statements
- `src/test-migration/core/test-runner.ts` - ~8 console statements
- `src/test-migration/core/transformer.ts` - ~4 console statements
- `src/utils/tempdir.ts` - ~6 console statements
- `src/utils/test-helpers.ts` - ~14 console statements
- `src/utils/test-utils.ts` - ~2 console statements
- `src/utils/test-utils/log-capture.ts` - ~16 console statements
- `src/utils/test-utils/compatibility/matchers.ts` - ~4 console statements
- `src/utils/test-utils/compatibility/module-mock.ts` - ~2 console statements
- `test-verification/manual-test.ts` - ~10 console statements
- `test-verification/quoting.test.ts` - ~2 console statements

#### 2. Import Style Issues (Medium Priority - ~15+ instances)

**Rule:** `no-restricted-imports`
**Issue:** Using `.js` extensions in imports
**Fix:** Remove `.js` extensions from local imports (Bun-native style)

#### 3. Command Import Restrictions (Medium Priority - ~3 instances)

**Rule:** `no-restricted-imports`
**Issue:** Command modules imported by other modules
**Fix:** Use domain modules instead of direct command imports

#### 4. TypeScript Any Types (Medium Priority - ~200+ instances)

**Rule:** `@typescript-eslint/no-explicit-any`
**Issue:** Usage of `any` type instead of proper typing
**Fix:** Replace with proper type definitions where possible

#### 5. Unused Variables (Medium Priority - ~100+ instances)

**Rule:** `@typescript-eslint/no-unused-vars`
**Issue:** Variables/imports defined but never used
**Fix:** Remove unused variables or prefix with `_` if required for API

#### 6. Import Statement Issues (Medium Priority - ~6+ instances)

**Rule:** `@typescript-eslint/no-var-requires`
**Issue:** Using `require()` instead of ES6 imports
**Fix:** Convert to ES6 import statements

#### 7. Magic Numbers (Low Priority - ~50+ instances)

**Rule:** `no-magic-numbers`
**Issue:** Hardcoded numeric values without named constants
**Fix:** Extract magic numbers to named constants

#### 8. Indentation Issues (Low Priority - ~10+ instances)

**Rule:** `indent`
**Issue:** Incorrect indentation spacing
**Fix:** Correct indentation to match project standards

### Phase 3: Verification

- [ ] Run linter again to ensure all issues are resolved
- [ ] Run test suite to ensure no functionality is broken
- [ ] Update any affected documentation

## Acceptance Criteria

1. **Zero linter errors**: `bun run lint` should exit with code 0
2. **Zero linter warnings**: No warnings should remain in the output
3. **All tests pass**: `bun test` should pass without failures
4. **Functionality preserved**: No breaking changes to existing functionality
5. **Consistent code style**: All code follows the established linting rules

## Files Requiring Major Attention

Based on the linter output, these files have the most issues:

### Test Migration Module (Heavy console issues)

- `src/test-migration/commands/analyze.ts` - 14 console errors, 4 warnings
- `src/test-migration/commands/batch.ts` - 28 console errors, 4 warnings
- `src/test-migration/commands/migrate.ts` - 18 console errors, 2 warnings
- `src/test-migration/core/test-runner.ts` - 8 console errors, 3 warnings
- `src/test-migration/core/transformer.ts` - 4 console errors, 4 warnings

### Utility Files (Console/import issues)

- `src/utils/test-helpers.ts` - 14 console errors, ~14 warnings
- `src/utils/tempdir.ts` - 6 console errors
- `src/utils/test-utils.ts` - 2 console errors, 4 warnings
- `src/utils/test-utils/log-capture.ts` - 16 console errors, 9 warnings

### Type Definition Files (Any types)

- `src/types/bun-test.d.ts` - 22 any warnings
- `src/types/node.d.ts` - 12 any warnings

### Test Utility Files (Any types, unused vars)

- `src/utils/test-utils/*.ts` (multiple files with various issues)

## Implementation Strategy

1. **Start with console statement fixes** - highest impact on error count
2. **Group similar fixes** to make logical commits
3. **Fix by file/module** to maintain context and reduce merge conflicts
4. **Test frequently** to catch any breaking changes early
5. **Commit incrementally** with descriptive messages for each category

## Risk Assessment

- **Low risk**: Console statement replacement (well-defined patterns)
- **Medium risk**: Import style changes, unused variable removal
- **High risk**: Any type replacements (may require significant type work)

## Success Metrics

- Reduction from 1,393 to 0 linting problems
- All tests continue to pass
- Code style consistency improved
- Maintainability enhanced through proper typing and logging
