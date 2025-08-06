# Improve test mock filesystem approach with external libraries

## Context

Survey current filesystem mocking in tests and evaluate migrating to established libraries like memfs for better testing practices

## Current State Analysis

### Existing Mock Filesystem Approaches

Our codebase currently uses **three different filesystem mocking approaches**:

1. **Custom In-Memory Maps** (most common)
   - Used in `real-world-workflow.test.ts`
   - Simple `Map<string, string>` for files, `Set<string>` for directories
   - Manual implementation of fs operations
   - ~15 lines of boilerplate per test file

2. **Enhanced Mock Filesystem Class**
   - Located in `src/utils/test-utils/enhanced-mocking.ts`
   - More sophisticated with validation and error simulation
   - ~300+ lines of implementation
   - Handles sync/async operations, stat info, directory traversal

3. **Basic Mock Utils**
   - Located in `src/utils/test-utils/filesystem/mock-filesystem.ts`
   - Factory function `createMockFilesystem()`
   - ~200 lines with comprehensive fs operation support

### Scale of Filesystem Usage in Tests

**192 filesystem operations across 31 test files**, including:
- `readFileSync`, `writeFileSync`, `mkdirSync`, `rmSync`
- Async equivalents: `readFile`, `writeFile`, `mkdir`, `rm`
- Complex operations: `stat`, `readdir`, `access`, `mkdtemp`

### Known Issues and Complexity

#### 1. **Infinite Loop Performance Issues** (Task #176)
Our custom mocking has caused 4+ billion millisecond test timeouts due to filesystem race conditions:
- `JsonFileTaskBackend`: 4,319,673,451ms → 241ms after fixes
- `SessionPathResolver`: 4,319,805,914ms → 143ms after fixes

#### 2. **Code Duplication**
Multiple filesystem mocking implementations with similar but not identical functionality.

#### 3. **Maintenance Burden**
- Custom implementations require ongoing maintenance
- Error handling inconsistencies across different mock approaches
- Limited coverage of edge cases compared to battle-tested libraries

#### 4. **Test Isolation Problems**
ESLint rule created (Task #332) to prevent real filesystem usage in tests after discovering race conditions and cross-test interference.

## External Library Research

### memfs (Recommended)
- **21M+ weekly downloads**
- **Full fs API compatibility** - works with both `fs` and `fs/promises`
- **Implementation-agnostic** - works with fs, fs-extra, graceful-fs
- **In-memory volume management** with `vol.fromJSON()` for complex directory structures
- **Active maintenance** - last updated 3 days ago
- **TypeScript support** built-in

**Key advantages:**
- Drop-in replacement for fs module via `vi.mock()` or `mock.module()`
- JSON-based directory structure creation
- No monkey-patching - safer approach
- Proven in production (used by major projects)

### mock-fs (Alternative)
- **689K weekly downloads**
- **Comprehensive fs mocking** with property control (permissions, dates, etc.)
- **Real file loading** with `mock.load()`
- **Maintenance concerns** - appears less actively maintained

### unionfs (Complementary)
- Works with memfs to **mix real and virtual filesystems**
- Useful for test fixtures that need real files

## Pain Points Analysis

### Current Custom Approach Issues

1. **Inconsistent Error Handling**
   ```typescript
   // Different error formats across implementations
   throw new Error(`ENOENT: no such file or directory, open '${path}'`);
   throw new Error(`ENOENT: no such file or directory, access '${path}'`);
   ```

2. **Incomplete fs API Coverage**
   - Missing operations like `copyFile`, `link`, `chmod`
   - Limited symlink support
   - No support for file streams

3. **Path Handling Inconsistencies**
   - Different path normalization across implementations
   - Windows vs Unix path handling not standardized

4. **Test Setup Complexity**
   ```typescript
   // Current: ~15 lines of boilerplate per test
   const mockFileSystem = new Map<string, string>();
   const mockDirectories = new Set<string>();
   const mockFs = {
     existsSync: mock((path: string) => mockFileSystem.has(path) || mockDirectories.has(path)),
     mkdirSync: mock((path: string) => { mockDirectories.add(path); }),
     // ... more boilerplate
   };
   ```

## Migration Evaluation

### Proposed memfs Approach
```typescript
// New: ~3 lines per test
import { vol } from 'memfs';
vol.fromJSON({
  '/path/to/file.txt': 'content',
  '/path/to/dir': {}
});
```

### Migration Effort Assessment

**Low Risk, High Value Migration:**

1. **Test Files to Update:** 31 files
2. **Filesystem Operations:** 192 instances
3. **Custom Mock Code to Remove:** ~500+ lines across 3 implementations

**Estimated Effort:** 2-3 days
- Day 1: Setup memfs infrastructure and convert 10 test files
- Day 2: Convert remaining test files, remove custom implementations
- Day 3: Validation, performance testing, documentation

### Benefits of Migration

1. **Reduced Maintenance Burden**
   - Remove ~500 lines of custom mock code
   - Delegate filesystem edge cases to battle-tested library

2. **Improved Test Reliability**
   - Eliminate custom mock bugs that caused infinite loops
   - Better error simulation and edge case handling

3. **Simplified Test Writing**
   - JSON-based directory structure setup
   - Consistent API across all tests

4. **Future-Proofing**
   - Automatic Node.js compatibility updates
   - Community-driven feature additions

## Requirements

### Primary Goals
1. **Survey Current Landscape** ✅
   - Catalog all filesystem mocking patterns in use
   - Identify complexity and maintenance burden
   - Document known issues and pain points

2. **Evaluate External Libraries**
   - Compare memfs, mock-fs, and alternatives
   - Assess compatibility with our test framework (bun:test)
   - Evaluate migration effort and breaking changes

3. **Create Migration Strategy**
   - Design phased migration approach
   - Identify high-priority test files for conversion
   - Plan removal of custom implementations

### Secondary Goals
- Establish testing best practices documentation
- Create utility functions for common test scenarios
- Improve test performance and reliability

## Solution

### Recommended Approach: Migrate to memfs

Based on research, **memfs** provides the best balance of:
- **Compatibility** with our existing fs usage patterns
- **Maintenance** with active development and large user base
- **Simplicity** with JSON-based setup and drop-in replacement
- **Performance** with proven track record in production

### Implementation Plan

#### Phase 1: Infrastructure Setup
- Add memfs dependency
- Create standardized test utilities
- Setup mock configuration for bun:test

#### Phase 2: High-Priority Conversion
- Convert files with known issues first (real-world-workflow.test.ts)
- Migrate most complex filesystem tests
- Remove custom EnhancedMockFileSystem class

#### Phase 3: Complete Migration
- Convert remaining test files
- Remove all custom mock implementations
- Update documentation and best practices

### Success Metrics
- **Code Reduction:** Remove 500+ lines of custom mock code
- **Test Reliability:** Eliminate filesystem-related test failures
- **Performance:** Maintain or improve test execution time
- **Maintainability:** Standardize on single mocking approach

## Notes

- **Critical Discovery:** Our custom mocking approach has caused billion-millisecond test timeouts
- **Industry Standard:** memfs is the de facto standard for Node.js filesystem mocking
- **Low Risk:** Migration is backwards-compatible with minimal breaking changes
- **High Value:** Significant reduction in maintenance burden and improved reliability
