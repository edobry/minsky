# Testing Guide

## Test Suites

Minsky has separate test suites to ensure fast, reliable development while maintaining comprehensive testing coverage.

### Unit Tests (Default)

**Command**: `bun test` or `bun run test`

- **Purpose**: Tests that run in isolation with mocked dependencies
- **Speed**: Fast (~2 seconds for full suite)
- **Dependencies**: No external APIs, no real filesystem operations
- **CI/Pre-commit**: Always runs on every commit (mandatory quality gate)
- **Coverage**: Core business logic, utilities, mocked integrations
- **Test Count**: 1,400+ tests with 0% failure tolerance

**Examples**:

```bash
bun test                    # Run all unit tests
bun run test:unit          # Same as above
bun run test:watch         # Watch mode for development
bun run test:coverage      # With coverage reporting
```

### Integration Tests (Manual)

**Command**: `bun run test:integration`

- **Purpose**: Tests that interact with real external systems
- **Speed**: Slower (can take minutes, depends on API responses)
- **Dependencies**: Real APIs (GitHub, Morph AI), network connectivity
- **CI/Pre-commit**: **Never runs automatically**
- **Coverage**: End-to-end workflows, real API interactions

**Examples**:

```bash
bun run test:integration   # Run all integration tests
```

**⚠️ Prerequisites for Integration Tests**:

- **GitHub API**: Set `GITHUB_TOKEN` environment variable
- **Morph AI**: Configure with `minsky config set ai.providers.morph.apiKey your-key`
- **Network**: Internet connectivity required

### All Tests

**Command**: `bun run test:all`

- **Purpose**: Runs both unit and integration tests
- **Use case**: Full validation before major releases
- **Note**: Requires all integration test prerequisites

## Test Architecture

### Dependency Injection

All tests use **explicit dependency injection** instead of global mocks:

```typescript
// ✅ GOOD: Explicit DI
const mockFs = createMockFilesystem();
const result = await someFunction(input, { filesystem: mockFs });

// ❌ BAD: Global mocking
mock.module("fs", () => mockFs);
```

### Real vs Mock APIs

| Test Type   | Filesystem | GitHub API | AI APIs  | Database |
| ----------- | ---------- | ---------- | -------- | -------- |
| Unit        | Mock       | Mock       | Mock     | Mock     |
| Integration | Mock       | **Real**   | **Real** | Mock     |

### Pre-commit Hook Integration

The enhanced pre-commit hook system includes multiple validation layers:

#### 1. **Code Formatting** (Automatic)

- Prettier automatically formats all staged files
- Prevents commits with syntax errors
- Ensures consistent code style

#### 2. **Unit Test Suite** (Quality Gate)

- Runs all 1,400+ unit tests with zero failure tolerance
- Fast execution (~2 seconds) designed for pre-commit use
- **Blocks commits entirely** if any test fails

#### 3. **Code Quality** (ESLint)

- Enforces coding standards and best practices
- Runs custom rules for project-specific patterns
- Identifies potential bugs and anti-patterns

#### 4. **Tooling Validation**

- Tests custom ESLint rules against fixtures
- Ensures development tools work correctly
- Separate from application tests

#### 5. **Secret Scanning**

- Scans for accidentally committed credentials
- Prevents security vulnerabilities
- Blocks commits containing sensitive data

**Benefits**:

- ✅ Fast feedback (~5-7 seconds total)
- ✅ No API rate limiting or network issues blocking commits
- ✅ No external service dependencies for development
- ✅ Comprehensive quality validation
- ✅ Security protection

## Common Commands

```bash
# Development (most common)
bun test                    # Fast unit tests only
bun run test:watch         # Watch mode for TDD

# Before major releases
bun run test:all           # Everything (requires API setup)

# Debugging specific issues
bun run test:integration   # Just the integration tests
bun test path/to/specific.test.ts  # Single test file
```

## Tests may not reach a live database

Under `bun test`, module state and configuration are shared across every file in one
process. Once _any_ test initializes configuration, the cockpit's production database
resolution path returns the real configured connection — which in this repo is
**production**. That is not theoretical: it wrote 31 rows into production tables across
four test runs before it was caught (mt#3254).

So `createCachedSqlDbGetter` (`src/cockpit/db-providers.ts`) refuses to resolve a database
when **all** of these hold:

- the getter was built **without** a `getProvider` seam (i.e. it resolves the real provider), and
- `NODE_ENV === "test"`, and
- `MINSKY_ALLOW_TEST_DB` is unset or empty.

It throws `TestEnvironmentDbAccessError` **before** contacting the provider, so no
connection is attempted and no connect-time side effect can occur.

### If you hit this error

The message names the two ways out. In order of preference:

1. **Inject a fake** through whichever seam the code under test offers — `getProvider` on
   the getter itself, or a route-level seam such as `overrideProjectRoutes: { getDb: async () => null }`
   / `orchestrateResume`. This is almost always the right answer: a test that reaches a real
   database is not hermetic regardless of which database it reaches.
2. **Opt in** with `MINSKY_ALLOW_TEST_DB=1` — only for a test that genuinely exercises a real
   **local** database. This is an explicit, deliberate escape hatch, not a way to silence the
   error. An empty value (`MINSKY_ALLOW_TEST_DB=`) does not count as consent, so a stray
   export cannot disable the guard by accident.

Note the guard covers the cockpit's cached getters. Code reaching persistence by another
path is not covered by it — hermeticity there is still the test author's responsibility.

## Troubleshooting

### "Integration tests failing"

1. Check API credentials (GitHub token, Morph config)
2. Verify network connectivity
3. Check API rate limits

### "Unit tests slow"

1. Ensure you're running `bun test` (not `bun run test:all`)
2. Check for accidental real API calls in unit tests
3. Verify proper dependency injection usage

### "Pre-commit hook taking too long"

**Normal execution time**: ~5-7 seconds total

If taking longer:

1. Check if integration tests are accidentally running (should never happen)
2. Verify test performance hasn't degraded
3. Report as a bug if consistently over 10 seconds

### "Pre-commit hook failing"

**Code formatting failures**:

- Fix syntax errors in staged files
- Run `bun run format` manually to identify issues

**Test failures**:

- Run `bun test --verbose` to see detailed failure information
- Fix failing tests before committing
- All 1,400+ tests must pass - zero tolerance for failures

**Linting failures**:

- Run `bun run lint` to see specific issues
- Use `bun run lint:fix` for auto-fixable problems
- Manually address remaining code quality issues

**Secret scanning failures**:

- Remove accidentally committed credentials
- Use placeholder values in documentation: `sk-proj-xxx...xxxxx`
- Never commit real API keys or sensitive data

## Adding New Tests

### Unit Test

- Place in `src/**/*.test.ts`
- Use dependency injection for all external dependencies
- Mock all APIs, filesystem, database operations
- Should run in <100ms typically

### Integration Test

- Place in `tests/integration/**/*.integration.test.ts`
- Can use real APIs with proper error handling
- Must handle API failures gracefully (skip if credentials missing)
- Document any required environment setup
