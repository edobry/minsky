# Test Analysis Report

Generated: 5/21/2025, 3:16:49 PM

Total test files analyzed: **53**

## Test Classification Summary

### By Mocking Complexity

| Complexity | Count | Percentage |
|-----------|-------|------------|
| low | 41 | 77.4% |
| medium | 9 | 17.0% |
| high | 3 | 5.7% |

### By Framework Dependency

| Framework | Count | Percentage |
|-----------|-------|------------|
| jest | 0 | 0.0% |
| vitest | 0 | 0.0% |
| bun | 52 | 98.1% |
| mixed | 0 | 0.0% |
| none | 1 | 1.9% |

### By Migration Difficulty

| Difficulty | Count | Percentage |
|-----------|-------|------------|
| easy | 46 | 86.8% |
| medium | 7 | 13.2% |
| hard | 0 | 0.0% |

### By Test Type

| Type | Count | Percentage |
|-----------|-------|------------|
| unit | 42 | 79.2% |
| integration | 11 | 20.8% |
| e2e | 0 | 0.0% |
| unknown | 0 | 0.0% |

## Top Test Utilities Usage

| Utility | Usage Count |
|---------|-------------|
| testUtils | 11 |
| createTestDeps | 4 |
| withMockedDeps | 1 |
| createTestSuite | 1 |

## Common Failing Patterns

### jest.spyOn usage (1 files)

- `src/utils/test-utils/__tests__/mocking.test.ts`


## Files by Migration Difficulty

### Hard (0 files)


### Medium (7 files)

- `src/utils/test-utils/__tests__/compatibility.test.ts` - low mocking, unit test
- `src/adapters/cli/utils/__tests__/shared-options.test.ts` - low mocking, unit test
- `src/domain/tasks.test.ts` - medium mocking, integration test
- `src/domain/__tests__/gitServiceTaskStatusUpdate.test.ts` - medium mocking, unit test
- `src/domain/__tests__/tasks.test.ts` - medium mocking, unit test
- `src/domain/git.test.ts` - low mocking, unit test
- `src/domain/git.pr.test.ts` - low mocking, unit test

### Easy (46 files)

- `src/utils/test-utils/__tests__/enhanced-utils.test.ts` - low mocking, unit test
- `src/utils/test-utils/__tests__/mocking.test.ts` - medium mocking, unit test
- `src/utils/__tests__/param-schemas.test.ts` - low mocking, unit test
- `src/utils/__tests__/option-descriptions.test.ts` - low mocking, unit test
- `src/utils/filter-messages.test.ts` - low mocking, unit test
- `src/utils/logger.test.ts` - low mocking, unit test
- `src/adapters/cli/__tests__/git-merge-pr.test.ts` - low mocking, unit test
- `src/adapters/__tests__/integration/rules.test.ts` - medium mocking, integration test
- `src/adapters/__tests__/integration/workspace.test.ts` - low mocking, integration test
- `src/adapters/__tests__/integration/mcp-rules.test.ts` - low mocking, integration test
- `src/adapters/__tests__/integration/tasks.test.ts` - medium mocking, integration test
- `src/adapters/__tests__/integration/tasks-mcp.test.ts` - medium mocking, integration test
- `src/adapters/__tests__/integration/git.test.ts` - low mocking, integration test
- `src/adapters/__tests__/integration/session.test.ts` - high mocking, integration test
- `src/adapters/__tests__/shared/commands/rules.test.ts` - low mocking, unit test
- ... and 31 more files


## Migration Strategy Recommendations

### Recommended Approach

1. **Start with "easy" tests** - First migrate tests with low mocking complexity
2. **Create utility adapters** - Develop adapters for common Jest patterns
3. **Standardize mocking utilities** - Enhance current mocking utilities
4. **Tackle integration tests last** - These often have the most complex mocking needs

### Priority Tests for Migration

- `src/utils/test-utils/__tests__/enhanced-utils.test.ts`
- `src/utils/test-utils/__tests__/mocking.test.ts`
- `src/utils/__tests__/param-schemas.test.ts`
- `src/utils/__tests__/option-descriptions.test.ts`
- `src/utils/filter-messages.test.ts`
- `src/utils/logger.test.ts`
- `src/adapters/cli/__tests__/git-merge-pr.test.ts`
- `src/adapters/__tests__/shared/commands/rules.test.ts`
- `src/adapters/__tests__/shared/commands/tasks.test.ts`
- `src/adapters/__tests__/shared/commands/git.test.ts`