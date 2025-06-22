# Task 136: Fix all ESLint warnings and errors across the codebase

## Current Status: IN-PROGRESS

### Session Progress Summary

**Starting Baseline (after main branch merge)**: ~3,700 total linting issues
**Previous session end**: 686 issues (81% reduction)
**Current Status**: 532 problems (14 errors, 518 warnings) - increase due to parsing error investigation
**Overall Progress**: 86% reduction from baseline
**Approach**: Systematic codemods targeting biggest issue types first

### Current Session Work - Parsing Error Focus

**Parsing Error Investigation and Fixes:**

1. **Critical Parsing Errors Identified**: 19 → 9 errors (53% reduction)

   - `src/domain/configuration/config-loader.ts`: Line 22 identifier expected
   - `src/schemas/session.ts`: Line 193 comma issue (FIXED - trailing comma in refine)
   - `src/utils/process.ts`: Line 33 function signature issue
   - `src/utils/repository-utils.ts`: Line 53 function signature issue
   - `src/utils/test-utils/assertions.ts`: Line 8 invalid character
   - `src/utils/test-utils/compatibility/index.ts`: Line 31 semicolon expected
   - `src/utils/test-utils/compatibility/mock-function.ts`: Line 120 colon expected
   - `src/utils/test-utils/factories.ts`: Line 187 numeric literal issue
   - `src/utils/test-utils/mocking.ts`: Line 28 semicolon expected

2. **Applied Fixes**:
   - Created `fix-all-parsing-errors.ts` codemod with targeted fixes
   - Applied manual fix to `session.ts` trailing comma issue
   - Attempted comprehensive parsing error resolution

**Current Metrics** (Commit: a2dd22c1):

- **Total Issues**: 532 problems (14 errors, 518 warnings)
- **Parsing Errors**: 9 remaining (down from 19)
- **Issue Count Change**: +16 from previous 516 (investigation added issues)

### Previous Session Achievement Summary

**Major Codemods Applied (686 → 516 reduction):**

1. **Unused Variables Cleanup**: Applied `fix-unused-vars-comprehensive.ts` (115 changes, 27 files)
2. **Quote Standardization**: Applied `fix-quotes-to-double.ts` (20 changes, 8 files)
3. **ESLint Autofix**: Multiple runs of `bun run lint --fix`
4. **Triple-Underscore Cleanup**: Applied `cleanup-triple-underscore-vars.ts` (40 changes, 24 files)
5. **Specific Unused Variables**: Applied `fix-remaining-specific-unused-vars.ts` (45 changes, 25 files)

**Progress Tracking:**

- Session start: 686 issues
- After comprehensive fixes: 516 issues
- After parsing investigation: 532 issues
- Overall reduction: 86% from ~3,700 baseline

### Technical Approach

**Methodology:**

- Using proven codemods from successful session work
- Applying fixes in order of biggest issue types first
- Systematic pattern-based regex replacements for efficient bulk fixes
- Commit after each major codemod application
- Focus on parsing errors blocking automated analysis

**Session Workspace**: `/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136`

### Next Actions

**Priority Issues to Address:**

1. **Complete Parsing Error Resolution** (9 remaining errors)

   - Manually investigate complex syntax issues in remaining 9 files
   - Fix function signature and interface issues
   - Resolve character encoding and syntax problems

2. **Continue No-Unused-Vars Reduction** (major category)

   - Apply additional unused variable codemods
   - Target remaining function parameters and variable declarations

3. **Address TypeScript Issues**

   - Handle @typescript-eslint/no-unused-vars warnings
   - Fix explicit-any type annotations where appropriate

4. **Magic Numbers and Other Categories**
   - Extract constants for frequently used numbers
   - Apply remaining automated fixes for smaller issue categories

### Repository Context

- Working in session workspace with absolute paths
- Changes committed progressively for tracking (latest: a2dd22c1)
- Parsing error fixes partially applied, investigation ongoing
- Current work focuses on eliminating blocking errors before automated cleanup

## Requirements

- Fix all ESLint warnings and errors across the codebase
- Use systematic automated approach where possible
- Maintain code functionality while improving quality
- Document progress and methodology
