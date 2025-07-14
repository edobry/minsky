# Cleanup excessive 'as unknown' assertions to improve TypeScript effectiveness

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Context

The codebase contains hundreds of `as unknown` type assertions throughout the test suite and domain code. These assertions:
- Mask real type errors and import issues
- Reduce TypeScript's effectiveness in catching bugs
- Make the code harder to maintain and understand
- Create technical debt that needs systematic cleanup

This technical debt was identified during Task #276 test suite optimization, where excessive `as unknown` assertions were hiding actual import path errors.

## Objectives

1. **Audit and Categorize `as unknown` Usage**
   - Scan entire codebase for `as unknown` assertions
   - Categorize by purpose (legitimate type bridging vs. error masking)
   - Identify patterns where proper typing can replace assertions

2. **Implement Systematic Cleanup**
   - Remove unnecessary `as unknown` assertions
   - Replace with proper type definitions where possible
   - Fix underlying type issues that necessitated assertions
   - Maintain type safety while reducing assertion count

3. **Establish Prevention Measures**
   - Add ESLint rules to discourage excessive `as unknown` usage
   - Document when `as unknown` is appropriate vs. alternatives
   - Create type utility functions for common assertion patterns

## Requirements

### Phase 1: Assessment and Planning
- [ ] Run comprehensive scan for all `as unknown` assertions
- [ ] Categorize each usage by necessity and context
- [ ] Identify quick wins vs. complex refactoring needed
- [ ] Create systematic cleanup plan with priorities

### Phase 2: Systematic Cleanup
- [ ] Remove unnecessary assertions that mask simple type errors
- [ ] Fix underlying type definitions that cause assertion needs
- [ ] Replace assertion patterns with proper type utilities
- [ ] Ensure all changes maintain type safety

### Phase 3: Prevention and Documentation
- [ ] Add ESLint rules to prevent future excessive assertions
- [ ] Document approved patterns for legitimate `as unknown` usage
- [ ] Create type utility functions for common scenarios
- [ ] Update development guidelines

## Success Criteria

- [ ] Significant reduction in `as unknown` assertion count (target: 50%+ reduction)
- [ ] All remaining assertions are documented and justified
- [ ] Type safety maintained or improved throughout cleanup
- [ ] Prevention measures in place to avoid regression
- [ ] Code quality and maintainability improved

## Priority

High - This technical debt is actively hindering development workflow and masking real issues.


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
