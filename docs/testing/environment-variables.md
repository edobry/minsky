# Test Environment Variables

## Overview

This document describes all environment variables that affect test behavior, console output, and system configuration in the Minsky project.

## Core Test Environment Variables

### `NODE_ENV`

- **Purpose**: Indicates the current environment
- **Test Value**: `"test"`
- **Set By**: Global test setup (`tests/setup.ts`)
- **Impact**: Enables test-specific behavior across the application

### `MINSKY_LOG_LEVEL`

- **Purpose**: Controls minimum log level for output
- **Test Value**: `"error"`
- **Set By**: Global test setup (`tests/setup.ts`)
- **Impact**: Reduces log noise by only showing errors and above

### `MINSKY_LOG_MODE`

- **Purpose**: Controls log output format
- **Test Value**: `"STRUCTURED"`
- **Set By**: Global test setup (`tests/setup.ts`)
- **Impact**: Forces structured JSON logging for consistency

## Console Mocking Control

### `DEBUG_TESTS`

- **Purpose**: Disables console mocking for debugging
- **Values**: `"1"` (enabled) or unset (disabled)
- **Usage**: `DEBUG_TESTS=1 bun test [file]`
- **Impact**:
  - When set: Console output visible, logger mocking bypassed
  - When unset: Clean test output, all console calls mocked

### `DEBUG`

- **Purpose**: Alternative debug flag (Node.js convention)
- **Values**: `"1"` (enabled) or unset (disabled)
- **Usage**: `DEBUG=1 bun test [file]`
- **Impact**: Same as `DEBUG_TESTS=1`

## Test Type Control

### `RUN_INTEGRATION_TESTS`

- **Purpose**: Enables integration test execution
- **Values**: `"1"` (enabled) or unset (disabled)
- **Usage**: `RUN_INTEGRATION_TESTS=1 bun test`
- **Impact**: Includes integration tests in test run

### `AGENT`

- **Purpose**: Indicates tests are running in CI/agent mode
- **Values**: `"1"` (enabled) or unset (disabled)
- **Usage**: Used in pre-commit hooks and CI
- **Impact**: May enable additional strict checking

### `CI`

- **Purpose**: Standard CI environment indicator
- **Values**: `"true"` (CI environment) or unset (local)
- **Set By**: CI systems (GitHub Actions, etc.)
- **Impact**: Enables stricter validation and different timeouts

## Package.json Script Environment Variables

### Standard Test Commands

```bash
# Clean test runs (console mocked)
bun run test           # Unit tests only
bun run test:unit      # Unit tests only
bun run test:integration  # Integration tests (RUN_INTEGRATION_TESTS=1)
bun run test:all       # All tests
```

### Debug Commands

```bash
# Debug test runs (console visible)
bun run test:debug                 # DEBUG_TESTS=1 unit tests
bun run test:debug:integration     # DEBUG_TESTS=1 integration tests
```

### Quality Monitoring

```bash
# Quality analysis (no special environment variables)
bun run test:quality    # Generate quality report
bun run test:flaky      # Show flaky tests
bun run test:slow       # Show slow tests
```

### Console Linting

```bash
# Console usage validation
bun run lint:console        # Show violations (non-blocking)
bun run lint:console:strict # Show violations (exit 1 on errors)
```

## Direct Environment Variable Usage

### Individual Test Files

```bash
# Debug specific test file
DEBUG_TESTS=1 bun test src/domain/task-service.test.ts

# Run integration test with debug
DEBUG_TESTS=1 RUN_INTEGRATION_TESTS=1 bun test tests/integration/

# Test with custom log level
MINSKY_LOG_LEVEL=debug bun test src/utils/logger.test.ts
```

### Multiple Variables

```bash
# Maximum visibility for debugging
DEBUG_TESTS=1 MINSKY_LOG_LEVEL=debug MINSKY_LOG_MODE=HUMAN bun test [file]

# CI-like strict mode
AGENT=1 CI=true bun test --timeout=10000 --bail
```

## Test Behavior Matrix

| Environment             | Console Mocking | Logger Mocking | Integration Tests | Log Level |
| ----------------------- | --------------- | -------------- | ----------------- | --------- |
| Default                 | ✅ Enabled      | ✅ Enabled     | ❌ Excluded       | error     |
| DEBUG_TESTS=1           | ❌ Disabled     | ❌ Disabled    | ❌ Excluded       | error     |
| RUN_INTEGRATION_TESTS=1 | ✅ Enabled      | ✅ Enabled     | ✅ Included       | error     |
| CI=true                 | ✅ Enabled      | ✅ Enabled     | ❌ Excluded       | error     |
| AGENT=1                 | ✅ Enabled      | ✅ Enabled     | ❌ Excluded       | error     |

## Debug Scenarios

### Debugging Test Failures

```bash
# See all console output and logs
DEBUG_TESTS=1 bun test failing-test.test.ts

# See only specific test with maximum verbosity
DEBUG_TESTS=1 MINSKY_LOG_LEVEL=debug bun test failing-test.test.ts --timeout=60000
```

### Debugging Logger Behavior

```bash
# Test logger with real console output
DEBUG_TESTS=1 MINSKY_LOG_MODE=HUMAN bun test logger.test.ts

# Test structured logging behavior
DEBUG_TESTS=1 MINSKY_LOG_MODE=STRUCTURED bun test logger.test.ts
```

### Debugging Integration Tests

```bash
# Full integration test with console output
DEBUG_TESTS=1 RUN_INTEGRATION_TESTS=1 bun test tests/integration/

# Single integration test with debugging
DEBUG_TESTS=1 RUN_INTEGRATION_TESTS=1 bun test tests/integration/cli.test.ts
```

## Pre-commit Hook Environment

The pre-commit hook uses these environment variables:

```bash
# Tests run with agent mode but clean output
AGENT=1 bun test --preload ./tests/setup.ts --timeout=15000 --bail

# Console linting runs in strict mode
bun run lint:console:strict  # (exits 1 on violations)
```

## Common Debugging Patterns

### Pattern 1: Silent Test Debug

```bash
# Test runs with mocked console but visible test framework output
bun test specific-test.test.ts
```

### Pattern 2: Full Visibility Debug

```bash
# Everything visible - console, logs, test output
DEBUG_TESTS=1 MINSKY_LOG_LEVEL=debug bun test specific-test.test.ts
```

### Pattern 3: Production-like Test

```bash
# Mimic production environment
NODE_ENV=production MINSKY_LOG_LEVEL=warn MINSKY_LOG_MODE=STRUCTURED bun test
```

### Pattern 4: CI Simulation

```bash
# Test as CI would run
CI=true AGENT=1 bun test --timeout=10000 --bail
```

## Troubleshooting

### Tests Not Showing Console Output

**Problem**: `console.log()` calls in tests aren't visible

**Solution**: Use debug mode:

```bash
DEBUG_TESTS=1 bun test your-test.test.ts
```

### Logger Not Working in Tests

**Problem**: Logger calls don't appear in test output

**Solution**: Check environment variables:

```bash
# For real logger output
DEBUG_TESTS=1 MINSKY_LOG_LEVEL=debug bun test your-test.test.ts

# For mock logger verification
import { wasMessageLogged } from './tests/setup';
expect(wasMessageLogged("Expected message", "info")).toBeTrue();
```

### Integration Tests Not Running

**Problem**: Integration tests are skipped

**Solution**: Enable integration test flag:

```bash
RUN_INTEGRATION_TESTS=1 bun test
# or
bun run test:integration
```

### Console Linting Failures

**Problem**: Pre-commit fails on console usage

**Solution**: Use appropriate logging:

```bash
# Check violations
bun run lint:console

# Fix by replacing console.* with logger.*
# Or use mock logger utilities in tests
```

## Best Practices

### Development

1. **Use debug mode for troubleshooting**: `DEBUG_TESTS=1` when investigating test failures
2. **Check quality regularly**: `bun run test:quality` to monitor test health
3. **Validate console usage**: `bun run lint:console` before committing

### CI/CD

1. **Use standard test commands**: Let package.json scripts handle environment variables
2. **Enable strict checking**: Use `--fail-on-error` flags in CI
3. **Monitor quality trends**: Track flaky and slow tests over time

### Testing

1. **Prefer clean output**: Use default test commands for regular development
2. **Debug with visibility**: Use `DEBUG_TESTS=1` only when needed
3. **Test logging behavior**: Use mock logger utilities to verify logging

## Environment Variable Precedence

1. **Direct shell export**: `export DEBUG_TESTS=1`
2. **Command prefix**: `DEBUG_TESTS=1 bun test`
3. **Package.json script**: Pre-configured in npm scripts
4. **Test setup defaults**: Set in `tests/setup.ts`

## Integration with Tools

### IDE/Editor Integration

- Set environment variables in run configurations
- Use debug scripts for better IDE debugging experience

### Continuous Integration

- CI systems automatically set `CI=true`
- Use package.json scripts to ensure consistent environment

### Pre-commit Hooks

- Uses `AGENT=1` for stricter validation
- Runs console linting in strict mode

This environment variable system provides fine-grained control over test behavior while maintaining clean, noise-free output by default.
