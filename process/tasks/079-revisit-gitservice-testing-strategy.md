# Task: Revisit GitService Testing Strategy

## Context

**Original Issue (Addressed Partially):**
The original tests for GitService in src/domain/git.test.ts were inadequate, testing only API structure rather than behavior. They relied on low-level mocking of execAsync, which created fragile tests.

**Current State (as of 2025-05-21):**
Significant improvements have been made through task #114 (test migration):
- Migrated from problematic Jest patterns to native Bun testing patterns
- Replaced low-level `execAsync` mocking with `spyOn(GitService.prototype, "method")`
- Added proper mock cleanup with `mock.restore()` in `afterEach`
- Tests now verify actual status object structure and content
- Basic error propagation testing implemented

**Remaining Gaps:**
1. **Limited coverage** - tests still focus on basic API validation rather than comprehensive business logic
2. **Dependency injection patterns** - while GitService has `PrDependencies` interface, main tests don't leverage DI effectively
3. **Complex workflows undertested** - critical methods like `clone()`, `pr()`, `mergeBranch()`, `stashChanges()` need comprehensive testing
4. **Integration vs unit testing** - tests still mock at service level rather than testing actual git workflow behaviors

## Requirements

### Phase 1: Enhanced Unit Testing (Current Priority)
1. ✅ ~~Replace low-level mocks with proper service-level mocking~~ (COMPLETED in task #114)
2. ✅ ~~Test actual behavior rather than just API shape~~ (PARTIALLY COMPLETED)
3. [ ] **Expand test coverage for complex GitService methods:**
   - `clone()` with various options and error scenarios
   - `pr()` workflow logic and edge cases
   - `mergeBranch()` conflict handling
   - `stashChanges()` and `popStash()` workflows
4. [ ] **Implement comprehensive error scenario testing:**
   - Git command failures
   - Network/authentication errors
   - Repository state conflicts
   - Invalid parameter combinations

### Phase 2: Dependency Injection Enhancement
5. [ ] **Refactor main GitService tests to use established DI patterns:**
   - Follow patterns from `git-pr-workflow.test.ts` which uses proper dependency injection
   - Use `PrDependencies` interface for consistent mocking
   - Leverage centralized `mocking.ts` utilities
6. [ ] **Create GitService test utilities similar to existing patterns:**
   - Extend `TestGitService` class for more comprehensive testing
   - Add factory functions for common test scenarios

### Phase 3: Integration Testing (Future Enhancement)
7. [ ] **Consider controlled integration testing:**
   - Use temporary git repositories for realistic workflow testing
   - Test actual git operations in isolated environments
   - Validate end-to-end workflows without external dependencies

## Implementation Steps

### Current Session Scope
1. [ ] **Assess current test coverage gaps:**
   - Review all GitService methods and their current test coverage
   - Identify the most critical untested or undertested methods
   - Create a test coverage matrix

2. [ ] **Implement comprehensive tests for high-priority methods:**
   - Focus on `clone()`, `pr()`, `mergeBranch()` workflows
   - Add extensive error scenario coverage
   - Use established mocking patterns from successful tests

3. [ ] **Refactor existing tests to use DI patterns:**
   - Align with patterns from `git-pr-workflow.test.ts`
   - Use centralized mocking utilities consistently
   - Improve test isolation and reliability

4. [ ] **Update test utilities and documentation:**
   - Enhance `TestGitService` if needed
   - Document testing patterns for future GitService development
   - Ensure test maintainability and discoverability

## Verification Criteria

### Completed (Phase 1 Basics)
- ✅ Tests don't rely on low-level execAsync mocking
- ✅ Tests use proper Bun testing patterns
- ✅ Basic mock cleanup is implemented

### Remaining (Current Session)
- [ ] **Coverage**: All critical GitService methods have comprehensive test coverage
- [ ] **Quality**: Tests verify actual behavior, not just API shape
- [ ] **Reliability**: Tests are stable and don't break on implementation details
- [ ] **Patterns**: Tests follow established DI patterns from other successful test files
- [ ] **Documentation**: Testing approach is documented for future maintenance

## Work Log
- **2025-05-16**: Task created due to problematic GitService.getStatus test
- **2025-05-21**: Git tests migrated to native Bun patterns (task #114)
- **2025-05-21**: Session started, task specification updated with current state analysis

## Related Tasks and Files
- **Task #114**: Migrate high-priority tests to native Bun patterns (COMPLETED)
- **Task #115**: Implement dependency injection test patterns (COMPLETED)
- **Reference**: `src/domain/__tests__/git-pr-workflow.test.ts` - exemplary DI testing patterns
- **Reference**: `src/utils/test-utils/mocking.ts` - centralized testing utilities
- **Reference**: `src/utils/test-utils/test-git-service.ts` - GitService testing utilities
