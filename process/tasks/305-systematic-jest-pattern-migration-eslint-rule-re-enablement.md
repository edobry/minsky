# Systematic Jest Pattern Migration & ESLint Rule Re-enablement

## Status

BACKLOG

## Priority

MEDIUM

## Description

Complete systematic migration of 265+ Jest patterns to Bun test patterns and re-enable ESLint enforcement.

## Context

Task #300 successfully implemented the `no-jest-patterns` ESLint rule with comprehensive pattern detection and auto-fix capabilities. However, the rule detected 265+ Jest patterns across the codebase, making it too disruptive to keep enabled immediately.

## Scope

**Current State:**
- ESLint rule `custom/no-jest-patterns` implemented and tested
- Rule temporarily disabled (`"off"`) to prevent blocking commits
- 265+ Jest patterns identified across test files

**Migration Required:**
- `.mockReturnValue()` → `mock(() => returnValue)`
- `.mockResolvedValue()` → `mock(() => Promise.resolve(value))`
- `.mockRejectedValue()` → `mock(() => Promise.reject(error))`
- `.mockImplementation()` → Bun equivalents
- `jest.fn()` → `mock()` with proper imports
- Mock setup patterns in test utilities

## Implementation Plan

### Phase 1: Automated Migration
1. **Auto-fix Simple Patterns**: Use `bun lint --fix` to convert basic patterns
2. **Codemod Creation**: Build targeted AST transformations for complex cases
3. **Test Utilities Update**: Modernize centralized mocking infrastructure

### Phase 2: Manual Migration  
1. **Complex Mock Setups**: Update elaborate test configurations
2. **Import Standardization**: Ensure consistent `bun:test` imports
3. **Pattern Verification**: Validate all conversions work correctly

### Phase 3: Rule Re-enablement
1. **Enable Rule**: Change `"off"` to `"error"` in `eslint.config.js`
2. **Pre-commit Integration**: Confirm Jest pattern prevention works
3. **Documentation Update**: Mark ESLint integration as fully active

## Acceptance Criteria

- [ ] All 265+ Jest patterns successfully migrated to Bun equivalents
- [ ] All tests continue passing after migration
- [ ] ESLint rule `custom/no-jest-patterns` re-enabled as `"error"`
- [ ] Pre-commit hooks preventing future Jest pattern introduction
- [ ] Documentation updated to reflect active enforcement
- [ ] Zero Jest patterns remaining in codebase

## Dependencies

- Builds on Task #300 ESLint rule implementation
- May require Task #061 Bun test pattern infrastructure updates
- Should coordinate with any ongoing test infrastructure work

## Impact

- **Developer Experience**: Clean enforcement without migration overhead
- **Code Quality**: Consistent Bun test patterns across entire codebase
- **Maintenance**: Automated prevention of Jest pattern regression
- **Testing**: Improved test reliability with modern Bun patterns

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
