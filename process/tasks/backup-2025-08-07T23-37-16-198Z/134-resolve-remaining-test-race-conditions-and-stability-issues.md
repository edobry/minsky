# Resolve Remaining Test Race Conditions and Stability Issues

## Context

Following the successful merge of task #130 (System Stability Post-CLI Bridge) and significant progress made on post-merge test failures, there are still remaining stability issues in the test suite that need to be resolved.

**Current Status:**

- ✅ Fixed critical syntax error in `src/domain/git.ts` regex pattern (line 1364)
- ✅ Fixed import styles to use extensionless imports for Bun compatibility
- ✅ Fixed `normalizeTaskId` mock to behave like real function
- ✅ Improved test isolation with UUID-based file paths
- ✅ Fixed command registration tests to expect correct counts
- ✅ Updated tasks command tests to register commands in beforeEach

**Remaining Issues:**

- ❌ JSON Storage Stack Overflow issues when tests run together (race conditions)
- ❌ Test interference between JsonFileStorage, JsonFileTaskBackend, and TaskService integration tests
- ❌ Potential Bun segmentation faults under high concurrent file operations

## Requirements

### 1. Resolve JSON Storage Test Race Conditions

**Problem:** Tests pass individually but fail when run together due to file system race conditions and test interference.

**Root Cause Analysis Required:**

- [ ] Investigate why multiple JsonFileStorage instances cause stack overflow
- [ ] Analyze file path collisions between concurrent tests
- [ ] Review initialization and cleanup patterns in storage tests

**Solutions to Implement:**

- [ ] Implement proper test isolation strategies for file-based storage
- [ ] Add mutex/locking mechanisms for concurrent file operations if needed
- [ ] Review and improve cleanup patterns in afterEach hooks
- [ ] Consider using in-memory storage for unit tests vs file storage for integration tests

### 2. Improve Test Suite Reliability

**Bun-Specific Considerations:**

- [ ] Research Bun test runner limitations with concurrent file operations
- [ ] Implement graceful handling of Bun segmentation faults
- [ ] Add test timeouts and retry mechanisms where appropriate
- [ ] Document known Bun testing limitations and workarounds

**Test Organization:**

- [ ] Separate unit tests from integration tests that require file system
- [ ] Implement test categories (fast/slow, unit/integration)
- [ ] Add ability to run tests sequentially vs in parallel based on category

### 3. Enhance Test Infrastructure

**Monitoring and Debugging:**

- [ ] Add test execution timing and resource usage monitoring
- [ ] Implement better error reporting for test failures
- [ ] Add debug flags for verbose test output during development

**Documentation:**

- [ ] Document current test patterns and best practices
- [ ] Create troubleshooting guide for common test issues
- [ ] Document the JSON storage test architecture decisions

## Implementation Steps

### Phase 1: Immediate Stability

- [ ] Implement sequential test execution for JSON storage tests
- [ ] Add proper file locking mechanisms if needed
- [ ] Improve cleanup in test teardown

### Phase 2: Architecture Improvements

- [ ] Separate unit tests from integration tests
- [ ] Implement test categorization system
- [ ] Add configurable test execution modes

### Phase 3: Long-term Reliability

- [ ] Add test suite monitoring and reporting
- [ ] Implement automated test stability checks in CI
- [ ] Document and standardize test patterns

## Verification

**Success Criteria:**

- [ ] Full test suite passes consistently on multiple runs
- [ ] No segmentation faults or stack overflow errors
- [ ] Test execution time is reasonable (< 60 seconds for full suite)
- [ ] All JSON storage-related tests pass both individually and together

**Testing Strategy:**

- [ ] Run full test suite 10 times consecutively without failures
- [ ] Test with different levels of concurrency
- [ ] Verify in both local development and CI environments

## Technical Notes

**Key Files Involved:**

- `src/domain/storage/__tests__/json-file-storage.test.ts`
- `src/domain/tasks/__tests__/jsonFileTaskBackend.test.ts`
- `src/domain/tasks/__tests__/taskService-jsonFile-integration.test.ts`
- Test utility files in `src/utils/test-utils/`

**Related Rules:**

- @bun-test-patterns.mdc for proper Bun testing patterns
- @designing-tests.mdc for test isolation and data management
- @test-infrastructure-patterns.mdc for testing boundaries

**Dependencies:**

- Builds on work completed in task #130
- May need coordination with future test infrastructure improvements
