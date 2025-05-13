# Task #059: Add Centralized Test Mock Utilities

## Context
Currently, mock setups are repeated across various test files. This leads to inconsistency and maintenance overhead. Centralizing common mocking patterns will improve test reliability and maintainability.

## Requirements
- Create a new module (e.g., `test-utils/mocking.ts`) for mock utilities.
- Include functions like `createMock`, `mockModule`, `setupTestMocks` (or similar) that encapsulate correct bun:test mocking patterns.
- Ensure these utilities correctly use `jest.fn()`, `mock.module()`, and `mock.restore()`.
- Update existing tests to use these new utilities where appropriate.

## Implementation Steps
- [ ] Create `src/utils/test-utils/mocking.ts`
- [ ] Implement `createMock` function using `jest.fn()`
- [ ] Implement `mockModule` function using `mock.module()`
- [ ] Implement `setupTestMocks` function with `afterEach` and `mock.restore()`
- [ ] Export utilities from `src/utils/test-utils/index.ts`
- [ ] Refactor `src/domain/__tests__/session.test.ts` to use new utilities
- [ ] Refactor integration tests (`src/adapters/__tests__/integration/*.test.ts`) to use new utilities
- [ ] Refactor other relevant test files
- [ ] Update documentation

## Verification
- [ ] All tests pass after refactoring.
- [ ] New tests correctly use the centralized utilities.
- [ ] The codebase shows reduced duplication in mock setups. 
