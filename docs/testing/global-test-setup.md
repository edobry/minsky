# Global Test Setup and Console Mocking System

## Overview

This document describes the comprehensive test setup system that eliminates console noise pollution during test execution while maintaining all test functionality.

## Problem Statement

Previously, our test suite was producing hundreds of lines of console output pollution including:

- Logger system flooding (info, debug, warn messages)
- Direct `console.log/warn/error` calls (240+ instances across tests)
- Configuration warnings and validation errors
- Mock cleanup messages and test setup output
- Debug messages from application code

This noise made it difficult to:
- Focus on actual test failures
- Identify real issues among the output flood
- Run tests cleanly in CI/CD pipelines
- Use tests effectively during development

## Solution Architecture

### 1. Global Test Setup (`tests/setup.ts`)

**Purpose**: Preloaded before all test execution to establish global mocking

**What it does**:
- Mocks the entire logger system (`src/utils/logger.ts`, `src/domain/utils/logger.ts`)
- Mocks all console API methods (`console.log`, `console.info`, `console.warn`, `console.error`, `console.debug`)
- Sets up test environment variables
- Provides utilities for tests that need to verify logging behavior

**How it's activated**:
```bash
bun test --preload ./tests/setup.ts [other-flags]
```

### 2. Mock Logger System (`src/utils/test-utils/mock-logger.ts`)

**Purpose**: In-memory logger that captures log messages without console output

**Key Features**:
- Captures all log levels (debug, info, warn, error, cli, agent, etc.)
- Provides utilities to check if specific messages were logged
- Maintains message history for test verification
- Compatible with existing logger API

**Usage in tests**:
```typescript
import { getLoggedMessages, wasMessageLogged } from './tests/setup';

// Verify logging behavior
expect(wasMessageLogged("Expected message", "info")).toBeTrue();

// Get all logged messages
const messages = getLoggedMessages();
expect(messages.length).toBe(3);
```

### 3. Quality Monitoring System (`tests/utils/test-monitor.ts`)

**Purpose**: Tracks test performance and reliability metrics

**Features**:
- Flaky test detection (tests with inconsistent pass/fail patterns)
- Performance monitoring (slow test identification)
- Test categorization (fast/medium/slow/flaky/critical)
- Historical tracking and trend analysis

**CLI Tool** (`tests/utils/test-quality-cli.ts`):
```bash
# Show comprehensive quality report
bun run test:quality

# List flaky tests
bun run test:flaky

# List slowest tests  
bun run test:slow
```

## Configuration

### Package.json Scripts

All test commands now use the preload setup:

```json
{
  "test": "bun test --preload ./tests/setup.ts --timeout=15000 src tests/adapters tests/domain",
  "test:unit": "bun test --preload ./tests/setup.ts --timeout=15000 src tests/adapters tests/domain",
  "test:integration": "RUN_INTEGRATION_TESTS=1 bun test --preload ./tests/setup.ts --timeout=30000",
  "test:all": "bun test --preload ./tests/setup.ts --timeout=30000",
  "test:watch": "bun test --preload ./tests/setup.ts --watch src tests/adapters tests/domain --timeout=15000",
  "test:coverage": "bun test --preload ./tests/setup.ts --coverage src tests/adapters tests/domain --timeout=15000"
}
```

### Environment Variables

The setup configures these test environment variables:

```typescript
process.env.NODE_ENV = "test";
process.env.MINSKY_LOG_LEVEL = "error";  // Minimum level for any actual logging
process.env.MINSKY_LOG_MODE = "STRUCTURED";  // JSON format for consistency
```

### Pre-commit Hook

The pre-commit hook uses `AGENT=1` mode plus our console mocking:

```bash
if ! AGENT=1 bun test --preload ./tests/setup.ts --timeout=15000 --bail src tests/adapters tests/domain; then
```

## Results

### Before (Console Noise Pollution)
```
Mock cleanup for directory: /mock/test-tmp/session-cli-test
Setting up test with mock storage path: /tmp/test-storage-123
Warning: Failed to parse config file /nonexistent/path
Debug: hasLocalPr=undefined, hasGitHubPr=undefined
[Logger] Info: Processing request...
[Logger] Debug: Validating parameters...
... hundreds more lines ...

1370 pass
0 fail
```

### After (Clean Output)
```
🔇 Global test setup: Logger and console mocked to prevent output during tests

 1370 pass
 0 fail
 3821 expect() calls
Ran 1371 tests across 171 files. [1123.00ms]
```

**Improvement**: From ~500 lines of noise to 4 clean lines (99.2% reduction in output noise)

## Debug Mode

For debugging tests that require console output, you can bypass the mocking:

### Option 1: Environment Variable
```bash
DEBUG_TESTS=1 bun test [test-file]
```

### Option 2: Direct Execution (bypasses setup)
```bash
bun test [test-file]  # without --preload flag
```

### Option 3: Test-specific Console Access
```typescript
// In tests that need real console output
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error
};

// Use originalConsole.log() for debugging output
```

## Best Practices

### For Test Authors

1. **Don't add console.log to tests**: Use the mock logger utilities instead
2. **Verify logging behavior**: Use `wasMessageLogged()` and `getLoggedMessages()`
3. **Test isolation**: Each test should be independent of logging state
4. **Performance awareness**: Use quality monitoring to catch slow tests

### For Application Code

1. **Use the logger system**: Don't use `console.*` directly in application code
2. **Structured logging**: Use appropriate log levels (debug, info, warn, error)
3. **Test-friendly code**: Consider whether code needs to log during tests

### For CI/CD

1. **Quality gates**: Use `bun run test:quality` to catch quality regressions
2. **Flaky test tracking**: Monitor `bun run test:flaky` for reliability issues
3. **Performance monitoring**: Track test duration trends

## Troubleshooting

### Tests Still Logging

If you see console output during tests:

1. **Check preload usage**: Ensure `--preload ./tests/setup.ts` is used
2. **Check direct console calls**: Look for `console.*` calls not going through logger
3. **Check native modules**: Some native modules may bypass our mocking

### Quality Monitoring Not Working

1. **Check data file**: Look for `.test-monitor-data.json` in project root
2. **Run tests multiple times**: Need execution history to detect patterns
3. **Check file permissions**: Ensure CLI can read/write monitoring data

### Mock Logger Issues

1. **Missing import**: Make sure to import utilities from `./tests/setup`
2. **State persistence**: Use `resetMockLogger()` if tests interfere with each other
3. **API compatibility**: Ensure mock logger matches actual logger interface

## Future Enhancements

1. **Test parallelization**: Leverage clean output for better parallel test reporting
2. **CI integration**: Automated quality reports in PR comments
3. **Performance benchmarking**: Track performance regressions over time
4. **Smart test selection**: Run only tests affected by changes

## Migration Guide

### Existing Tests

Most tests should work without changes. For tests that relied on console output:

1. **Replace console assertions**: Use mock logger utilities instead
2. **Remove debug console.log**: Use proper test assertions
3. **Update cleanup code**: Remove manual console cleanup

### New Tests

1. **Use mock logger utilities**: Import from `./tests/setup`
2. **Test logging behavior**: Verify expected log messages
3. **Follow clean test principles**: No console output in tests

