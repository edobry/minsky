# Continue Systematic ESLint-Guided Filesystem Violation Fixes

## Context

Continue the systematic approach to fixing the remaining 117 ESLint filesystem violations using proven patterns from Task 176 and comprehensive test failure guides. Focus on eliminating real filesystem operations in tests through dependency injection patterns.

## Current Status
- **Started with**: 657+ filesystem violations  
- **Current**: 117 violations (82.2% improvement)
- **ESLint Rule**: `minsky/no-real-fs-in-tests` actively guiding fixes

## Proven Systematic Methodology

### 1. **ESLint-Guided Detection Pattern** ✅
Use ESLint rule output to systematically identify and categorize violations:
```bash
bun run lint 2>&1 | grep "custom/no-real-fs-in-tests" | head -10
```

### 2. **Template Literal Pattern** (From fix-remaining-test-failures guide)
Replace magic strings and repeated path construction:
```typescript
// ❌ AVOID: Magic strings and repetition
tempDir = join(tmpdir(), "session-test-" + Date.now());

// ✅ PROVEN: Template Literal Pattern with static mock paths
const tempDir = "/mock/tmp/session-test-static";
```

### 3. **Dependency Injection Pattern** (From Task 176)
Core architectural principle for test isolation:
```typescript
// ❌ AVOID: Real filesystem operations
import { mkdirSync, writeFileSync } from "fs";
mkdirSync(testDir, { recursive: true });

// ✅ PROVEN: Mock filesystem utilities with DI
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";
const mockFs = createMockFilesystem();
mock.module("fs", () => mockFs);
```

### 4. **Static Mock Path Pattern** ✅
Eliminate environment dependencies and race conditions:
```typescript
// ❌ AVOID: Dynamic path generation
tempDir = join(process.cwd(), "temp-" + Date.now());

// ✅ PROVEN: Static mock paths
const tempDir = "/mock/tmp/test-static-path";
```

### 5. **Mock Cleanup Pattern** ✅
Replace real filesystem cleanup with mock operations:
```typescript
// ❌ AVOID: Real filesystem cleanup
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ✅ PROVEN: Mock cleanup
afterEach(async () => {
  // Mock cleanup - avoiding real filesystem operations
});
```

## Categories Successfully Fixed

### ✅ Global Counters → Test-Scoped Variables
- Fixed `TEST_PR_NUMBER` global counters
- Moved to test-scoped variables to prevent cross-test interference

### ✅ tmpdir() Usage → Static Mock Paths  
- Replaced `tmpdir()` imports with static mock paths
- Eliminated race conditions from dynamic path generation

### ✅ Real Filesystem Operations in Test Hooks
- Replaced `mkdir`, `writeFileSync`, `rmSync` with mock operations
- Applied dependency injection patterns consistently

### ✅ process.cwd() + Date.now() Usage
- Replaced dynamic path generation with static mock paths
- Eliminated environment dependencies

## Remaining Violation Patterns (117 total)

### High Priority Categories:
1. **Real filesystem imports**: `import { existsSync } from "fs"`
2. **Test hook filesystem operations**: `mkdir`, `writeFile`, `rm` in beforeEach/afterEach
3. **Dynamic path generation**: `process.cwd()`, `tmpdir()`, `Date.now()`
4. **Global test variables**: Module-level counters and state

### Medium Priority Categories:
1. **Commented filesystem imports**: `// import { mkdir } from "fs"`
2. **Mock filesystem setup**: Files needing `mock.module()` configuration
3. **File existence checks**: `existsSync()` calls in test logic

## Systematic Workflow

### Step 1: Identify Violation Pattern
```bash
bun run lint 2>&1 | grep "custom/no-real-fs-in-tests" | head -5
```

### Step 2: Apply Proven Pattern
- **Real filesystem operation** → Apply **Dependency Injection Pattern**
- **Dynamic path generation** → Apply **Static Mock Path Pattern**  
- **Global test variables** → Apply **Test-Scoped Variables Pattern**
- **Test hook side effects** → Apply **Mock Cleanup Pattern**

### Step 3: Verify & Track Progress
```bash
bun run lint 2>&1 | grep "custom/no-real-fs-in-tests" | wc -l
git add . && git commit -m "fix: [pattern] - [description]"
```

## Success Metrics
- **Target**: Reduce 117 violations to <20 (83% additional reduction)
- **Quality**: Maintain 100% test success rate throughout fixes
- **Consistency**: Apply proven patterns uniformly across all files
- **Performance**: Maintain fast test execution with mock operations

## Reference Patterns from Task 176
- **Universal DI patterns**: Proven across git, session, task, utility domains
- **Perfect test isolation**: Zero global state contamination
- **Type-safe pattern application**: `createPartialMock<T>()` for flexible mocking
- **Cross-service integration**: Multi-service workflows through DI

## Architecture Benefits
- **Test Isolation**: Complete prevention of cross-test interference
- **Performance**: Sub-10ms execution vs slow external operations  
- **Maintainability**: Unified DI system easier to understand and extend
- **Reliability**: Perfect test isolation eliminates flaky test scenarios

## Next Actions
1. Continue systematic ESLint rule guided fixes
2. Apply proven patterns from Task 176 and test failure guides
3. Maintain momentum toward <20 violations target
4. Document any new patterns discovered during implementation

## Requirements

## Solution

## Notes
