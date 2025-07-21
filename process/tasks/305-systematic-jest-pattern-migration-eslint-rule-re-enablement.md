# Systematic Jest Pattern Migration & ESLint Rule Re-enablement

## Status

IN-PROGRESS

## Priority

HIGH

## Description

Complete systematic migration of Jest patterns to Bun test patterns and re-enable ESLint enforcement. **CRITICAL**: Task requires achieving 0 ESLint violations for completion - partial migration is not sufficient.

## Context

Task #300 successfully implemented the `no-jest-patterns` ESLint rule with comprehensive pattern detection and auto-fix capabilities. However, the rule detected 217+ Jest patterns across the codebase, making it too disruptive to keep enabled immediately.

## Current Progress Status

**✅ COMPLETED IN SESSION:**
- **AST-Based Migration Framework**: Created proper Jest-to-Bun migration codemod in `codemods/` directory following established patterns
- **Significant Pattern Reduction**: ESLint violations reduced from 217 → 48 patterns (78% reduction)
- **Grep Pattern Reduction**: Jest patterns reduced from 189 → 165 matches (13% reduction)
- **Systematic AST Approach**: Used `ts-morph` with proper `CodemodBase` framework (not regex)
- **Comprehensive Pattern Coverage**: Implemented transformations for all major Jest patterns
- **Regulatory System Enhancement**: Added enhanced implementation verification protocol with mandatory triggers

**⚠️ REMAINING CRITICAL WORK:**
- **48 ESLint violations** still detected by `custom/no-jest-patterns` rule
- **165 grep patterns** remain in codebase
- **Syntax errors** from incomplete chained method call transformations
- **spyOn pattern conflicts** - rule incorrectly flags valid Bun patterns
- **Final verification required** - tests must pass, ESLint must show 0 violations

## Scope

**Migration Progress:**
- ✅ `jest.fn()` → `mock()` conversions
- ✅ Basic `.mockReturnValue()` → `mock(() => returnValue)` conversions
- ✅ Basic `.mockResolvedValue()` → `mock(() => Promise.resolve(value))` conversions
- ⚠️ Complex chained `.mockResolvedValueOnce()` patterns (partial/syntax errors)
- ⚠️ `.mockImplementation()` on `spyOn` (should work in Bun, incorrectly flagged)
- ⚠️ Remaining pattern detection edge cases

**Key Findings:**
- **Chained Method Calls**: Most complex - multiple `.mockResolvedValueOnce()` calls create syntax conflicts
- **spyOn Compatibility**: `spyOn().mockImplementation()` works in Bun but ESLint rule flags it incorrectly
- **AST Approach Effectiveness**: AST-first approach using established codemod framework was 6x more effective than regex

## Implementation Plan

### ✅ Phase 1: Automated Migration (COMPLETED)
1. ✅ **AST Codemod Creation**: Built systematic Jest-to-Bun migration tool in `codemods/` directory
2. ✅ **Pattern Detection**: Successfully identified and converted 169+ patterns
3. ✅ **Framework Integration**: Used established `CodemodBase` framework following guidelines

### 🚧 Phase 2: Edge Case Resolution (IN PROGRESS)
1. **Fix Chained Method Calls**: Resolve syntax errors from incomplete transformations
2. **ESLint Rule Refinement**: Fix incorrect flagging of valid `spyOn().mockImplementation()` patterns
3. **Manual Pattern Cleanup**: Handle remaining 48 complex patterns individually
4. **Test Verification**: Ensure all migrations preserve functionality

### ⏳ Phase 3: Rule Re-enablement (PENDING)
1. **Achieve 0 Violations**: Must reach exactly 0 ESLint violations for completion
2. **Test Suite Validation**: All tests must pass with migrated patterns
3. **Rule Activation**: Change `"off"` to `"error"` in `eslint.config.js`
4. **Documentation Update**: Mark ESLint integration as fully active

## Critical Success Criteria

**MANDATORY FOR COMPLETION:**
- **0 ESLint violations** from `bun lint 2>&1 | grep "custom/no-jest-patterns" | wc -l`
- **0 Jest patterns** from `grep -r "\.mockResolvedValue\|\.mockReturnValue" --include="*.ts" src/ | wc -l`
- **All tests passing** after migration
- **ESLint rule re-enabled** as `"error"`

**Note**: Following Implementation Verification Protocol - cannot claim completion without showing actual verification command output of 0.

## Implementation Notes

**Successful Approaches:**
- ✅ AST-first approach using `ts-morph` (established framework)
- ✅ `CodemodBase` pattern from existing codemods
- ✅ Systematic pattern identification and batch processing

**Approaches to Avoid:**
- ❌ Regex-based transformations (violates established guidelines)
- ❌ Manual file-by-file editing (not systematic)
- ❌ Ad-hoc scripts outside codemods framework

**Remaining Technical Challenges:**
- Complex chained method call transformations require careful AST manipulation
- ESLint rule needs refinement to not flag valid Bun patterns
- Some test files have deeply nested mock setups requiring manual attention

## Acceptance Criteria

- [x] AST-based migration framework created following established patterns
- [x] 78% reduction in ESLint violations achieved (217 → 48)
- [ ] **0 ESLint violations** from `custom/no-jest-patterns` rule
- [ ] **0 Jest patterns** detected by grep search
- [ ] All tests continue passing after migration
- [ ] ESLint rule `custom/no-jest-patterns` re-enabled as `"error"`
- [ ] Pre-commit hooks preventing future Jest pattern introduction
- [ ] Documentation updated to reflect active enforcement

## Dependencies

- Builds on Task #300 ESLint rule implementation
- Enhanced Implementation Verification Protocol (created during this task)
- Existing codemod framework in `codemods/` directory

## Impact

- **Developer Experience**: Clean enforcement without migration overhead
- **Code Quality**: Consistent Bun test patterns across entire codebase
- **Maintenance**: Automated prevention of Jest pattern regression
- **Testing**: Improved test reliability with modern Bun patterns
- **Regulatory Enhancement**: Improved verification protocols prevent premature completion declarations
