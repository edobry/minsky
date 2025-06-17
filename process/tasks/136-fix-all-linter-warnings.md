# Task 136: Fix all ESLint warnings and errors across the codebase

## Progress Log (Session: fix-task-status-errors)

### Completed
- Verified and switched to session workspace, using absolute paths for all edits per session-first-workflow.
- Fixed all console statement errors in:
  - debug-mcp.js
  - detect-placeholder-tests.ts
  - final-test.js
- Used `log.cli`, `log.debug`, and `log.error` as appropriate.
- Addressed type issues for process exit in Bun scripts (using `(process as any).exit`).
- Left only warnings (magic numbers, any type assertions) in these files.

### Next Steps
- Continue fixing console statement errors in remaining files flagged by ESLint.
- After console issues, address `no-explicit-any` and `no-unused-vars` errors.
- Document any complex or unresolvable issues in the task spec.

### Notes
- All changes are being made in the session workspace using absolute paths.
- Warnings for magic numbers and any type assertions are being left for now unless they are critical.
- Progress is being tracked and committed after each logical group of fixes.

## Summary

Fix all ESLint warnings and errors across the codebase. There are currently **1,764 problems (765 errors, 999 warnings)** with **342 errors potentially fixable with the `--fix` option**.

## Background

The codebase has accumulated significant linting issues that need systematic resolution. The linter output shows various categories of problems that require both automated fixes and manual intervention.

## Requirements

### Phase 1: Automated Fixes

- [ ] Run `bun run lint:fix` to automatically fix all auto-fixable issues
- [ ] Verify that automated fixes don't break functionality
- [ ] Commit automated fixes as a single logical change

### Phase 2: Manual Fixes by Category

#### 1. Quote Style Issues (High Priority - ~200+ instances)

**Rule:** `quotes` - Strings must use doublequote
**Files affected:** Almost all files in test-migration, utils, and other modules
**Fix:** Convert all single quotes to double quotes in string literals

#### 2. Console Statement Issues (High Priority - ~50+ instances)

**Rule:** `no-console`, `no-restricted-properties`
**Issue:** Direct console._ usage instead of logger
**Fix:** Replace with appropriate log._ methods:

- `console.log` → `log.cli()` (user-facing) or `log.debug()` (debugging)
- `console.error` → `log.error()` (internal) or `log.cliError()` (user-facing)
- `console.warn` → `log.warn()` (internal) or `log.cliWarn()` (user-facing)

#### 3. Import Style Issues (Medium Priority - ~20+ instances)

**Rule:** `no-restricted-imports`
**Issue:** Using `.js` extensions in imports
**Fix:** Remove `.js` extensions from local imports (Bun-native style)

#### 4. TypeScript Any Types (Medium Priority - ~200+ instances)

**Rule:** `@typescript-eslint/no-explicit-any`
**Issue:** Usage of `any` type instead of proper typing
**Fix:** Replace with proper type definitions where possible

#### 5. Unused Variables (Medium Priority - ~100+ instances)

**Rule:** `@typescript-eslint/no-unused-vars`
**Issue:** Variables/imports defined but never used
**Fix:** Remove unused variables or prefix with `_` if required for API

#### 6. Magic Numbers (Low Priority - ~50+ instances)

**Rule:** `no-magic-numbers`
**Issue:** Hardcoded numeric values without named constants
**Fix:** Extract magic numbers to named constants

#### 7. Import Statement Issues (Medium Priority - ~10+ instances)

**Rule:** `@typescript-eslint/no-var-requires`
**Issue:** Using `require()` instead of ES6 imports
**Fix:** Convert to ES6 import statements

#### 8. Indentation Issues (Low Priority - ~10+ instances)

**Rule:** `indent`
**Issue:** Incorrect indentation spacing
**Fix:** Correct indentation to match project standards

#### 9. Command Import Restrictions (Medium Priority - ~5+ instances)

**Rule:** `no-restricted-imports`
**Issue:** Command modules imported by other modules
**Fix:** Use domain modules instead of direct command imports

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

### Test Migration Module (Heavy quote/console issues)

- `src/test-migration/core/transformer.ts`
- `src/test-migration/patterns/registry.ts` (~80+ quote issues)
- `src/test-migration/transformers/*.ts` (multiple files)
- `src/test-migration/utils/diff.ts`

### Utility Files (Console/import issues)

- `src/utils/test-helpers.ts` (~15+ console statements)
- `src/utils/tempdir.ts` (console statements)
- `src/utils/logger.ts` (any types)
- `src/utils/package-manager.ts` (indentation, quotes, imports)

### Type Definition Files (Any types)

- `src/types/bun-test.d.ts` (~22 any types)
- `src/types/node.d.ts` (~12 any types)

### Test Utility Files (Any types, unused vars)

- `src/utils/test-utils/*.ts` (multiple files with various issues)

## Implementation Strategy

1. **Start with automated fixes** to reduce the problem size
2. **Group similar fixes** to make logical commits
3. **Fix by file/module** to maintain context and reduce merge conflicts
4. **Test frequently** to catch any breaking changes early
5. **Commit incrementally** with descriptive messages for each category

## Risk Assessment

- **Low risk**: Quote fixes, unused variable removal, magic number extraction
- **Medium risk**: Console statement replacement, import style changes
- **High risk**: Any type replacements (may require significant type work)

## Success Metrics

- Reduction from 1,764 to 0 linting problems
- All tests continue to pass
- Code style consistency improved
- Maintainability enhanced through proper typing and logging
