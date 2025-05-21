# Migration Notes for Task #114

This file tracks the progress and patterns identified during the migration of high-priority tests to native Bun patterns.

## Setup Progress

### Environment Setup (Completed)
- Created directory structure for migration documentation
- Ran updated test analysis to reflect current state
- Created migration criteria documentation
- Created migration template for consistent documentation
- Created prioritized migration backlog with rationale
- Established verification and success criteria

### Next Steps
- Continue with migration of the second priority test (mocking.test.ts)
- Document patterns and challenges encountered
- Create reusable utilities for common patterns

## Migration Pattern Library

Below are common patterns encountered during migrations:

| Jest/Vitest Pattern | Bun Equivalent | Notes |
|---------------------|----------------|-------|
| `jest.fn()` | `mock()` | Basic function mocking |
| `jest.fn().mockReturnValue(x)` | `mock(() => x)` | Mocking return values |
| `jest.mock('module')` | `mock.module('module', () => {})` | Module mocking |
| `jest.spyOn(object, 'method')` | Custom spy implementation | Needs special handling |
| `beforeEach/afterEach` | `import { beforeEach, afterEach } from 'bun:test'` | Test lifecycle hooks |
| Missing import extensions | `import from './file.js'` | ESM requires explicit extensions |

## Test Migration Status

| Test File | Status | Migration Difficulty | Notes |
|-----------|--------|----------------------|-------|
| `src/utils/test-utils/__tests__/enhanced-utils.test.ts` | Completed | Easy | Fixed import issues, added explicit beforeEach/afterEach imports, added .js extensions |
| `src/utils/test-utils/__tests__/mocking.test.ts` | Not Started | Easy | Priority 1, Contains jest.spyOn |
| `src/utils/filter-messages.test.ts` | Not Started | Easy | Priority 1 |
| `src/utils/logger.test.ts` | Not Started | Easy | Priority 1 |
| `src/domain/__tests__/tasks.test.ts` | Not Started | Medium | Priority 2 |
| `src/domain/git.test.ts` | Not Started | Medium | Priority 2 |
| `src/domain/git.pr.test.ts` | Not Started | Medium | Priority 2 |
| `src/domain/session/session-db.test.ts` | Not Started | Easy | Priority 2 |
| `src/adapters/__tests__/shared/commands/rules.test.ts` | Not Started | Easy | Priority 3 |
| `src/adapters/__tests__/shared/commands/tasks.test.ts` | Not Started | Easy | Priority 3 |
| `src/adapters/__tests__/shared/commands/git.test.ts` | Not Started | Easy | Priority 3 |
| `src/adapters/__tests__/shared/commands/session.test.ts` | Not Started | Easy | Priority 3 |
| `src/adapters/cli/__tests__/git-merge-pr.test.ts` | Not Started | Easy | Priority 3 |
| `src/utils/__tests__/param-schemas.test.ts` | Not Started | Easy | Priority 4 |
| `src/utils/__tests__/option-descriptions.test.ts` | Not Started | Easy | Priority 4 |
| `src/utils/test-utils/__tests__/compatibility.test.ts` | Not Started | Medium | Priority 4 |
| `src/adapters/__tests__/integration/tasks.test.ts` | Not Started | Easy | Priority 5 |
| `src/adapters/__tests__/integration/git.test.ts` | Not Started | Easy | Priority 5 |
| `src/adapters/__tests__/integration/rules.test.ts` | Not Started | Easy | Priority 5 |
| `src/adapters/__tests__/integration/workspace.test.ts` | Not Started | Easy | Priority 5 |

## Lessons Learned

1. **ESM Import Requirements**
   - Bun uses ES Modules which require explicit file extensions in relative imports (e.g., `from './file.js'`)
   - Import changes are needed even when the test is already using Bun test patterns

2. **Lifecycle Hook Imports**
   - `beforeEach` and `afterEach` must be explicitly imported from `bun:test`
   - Global Jest equivalents are not available in Bun
