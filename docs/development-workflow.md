# Development workflow & quality gates

The hooks, gates, and feedback loops that shape how code gets written in this repo. Pre-commit catches formatting and type errors before they leave the editor; pre-push runs the broader checks before code reaches the remote; CI is the third gate before merge. Each layer routes the cheaper decisions to the substrate and surfaces only what requires human judgement — the same routing principle the top-level [README](../README.md) §"Attention as the scarce resource" names. When a hook denies an action, its message names the rule and the override mechanism; that is the system-speaks register the hooks themselves implement.

## Overview

Quality gates run in sequence; each layer serves a distinct purpose. The earliest layer (pre-commit) catches the fastest issues; the latest layer (CI) catches the cross-cutting ones. Cost scales with depth: a pre-commit failure is a 2-second loop, a CI failure is a 5-minute loop, a post-merge regression is a 24-hour loop. The gates are ordered to make the cheap failures unmissable so the expensive ones are rare.

## Pre-Commit Hook Architecture

### Multi-Layered Validation System

The pre-commit hooks run in a specific sequence, with each layer serving a distinct purpose:

```
┌─────────────────────────────────────────────────────────────┐
│                    Git Commit Initiated                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│           1. 🎨 Code Formatting (Prettier)                  │
│  • Formats all staged files automatically                   │
│  • Validates syntax and prevents syntax errors              │
│  • Ensures consistent code style                            │
└─────────────────────┬───────────────────────────────────────┘
                      │ ✅ Formatting successful
┌─────────────────────▼───────────────────────────────────────┐
│           2. 🧪 Fast checks only — NOT the full suite       │
│  • The full unit suite is NOT run in pre-commit (mt#2716)   │
│  • ~8300 tests ≈ 4.3 min: the "slow hook → --no-verify →    │
│    worse than no hook" anti-pattern; it also never worked    │
│    (old 120s timeout < honest suite; bun truncated it)      │
│  • Full suite now runs in pre-push + CI (see §2 below)      │
└─────────────────────┬───────────────────────────────────────┘
                      │ ✅ Fast checks passing
┌─────────────────────▼───────────────────────────────────────┐
│           3. 🔍 ESLint Code Quality                          │
│  • Identifies code quality issues                           │
│  • Enforces project coding standards                        │
│  • Runs custom rules for best practices                     │
└─────────────────────┬───────────────────────────────────────┘
                      │ ✅ Linting successful
┌─────────────────────▼───────────────────────────────────────┐
│           4. 🔧 ESLint Rule Tooling Tests                   │
│  • Validates custom ESLint rules                            │
│  • Tests rule fixtures and behavior                         │
│  • Ensures development tooling quality                      │
└─────────────────────┬───────────────────────────────────────┘
                      │ ✅ Tooling tests passed
┌─────────────────────▼───────────────────────────────────────┐
│           5. 🔒 Secret Scanning (Gitleaks)                  │
│  • Scans for accidentally committed credentials             │
│  • Detects API keys, tokens, and sensitive data             │
│  • Blocks commits containing secrets                        │
└─────────────────────┬───────────────────────────────────────┘
                      │ ✅ No secrets detected
┌─────────────────────▼───────────────────────────────────────┐
│                 ✅ Commit Successful                         │
└─────────────────────────────────────────────────────────────┘
```

### Implementation Details

#### 1. Code Formatting Layer

**Purpose**: Ensure consistent code style and prevent syntax errors

**Technology**: Prettier with project-specific configuration

**Files affected**: `.ts`, `.js`, `.json`, `.md`

**Behavior**:

- Automatically formats all staged files
- Validates syntax during formatting
- Fails if syntax errors prevent formatting
- Changes are applied before commit

**Configuration**: `.prettierrc` and `package.json`

```bash
# Manual execution
bun run format
```

#### 2. Test tiering — the full suite runs at pre-push + CI, not pre-commit (mt#2716)

**Purpose**: Catch failing tests before code is shared, without taxing every commit.

The full unit suite (~8300 tests, ~4.3 min) is deliberately NOT run in pre-commit.
Running it on every commit is the well-documented "slow hook → developers
`--no-verify` it → worse than no hook" anti-pattern; the old pre-commit full-suite
step also never actually worked (its 120s `execAsync` timeout was shorter than the
honest suite, and `bun test` 1.2.21 silently truncated it — exit 0, no completion
summary — so it false-passed; see `docs/testing-patterns.md` and mt#2665). The suite
is placed by cost, following common practice for large suites:

- **Pre-commit** — fast static checks (format, type check, ESLint, secret scan,
  repo-integrity guards) plus the niche ESLint-rule tooling tests. No full suite.
- **Pre-push** (`.husky/pre-push` → `scripts/run-tests-gated.ts`) — the local test
  gate, run less often (before code is shared). Runs the same two steps CI runs
  (`scripts/run-tests-main.ts`, `src/mcp` excluded, + `scripts/run-tests-mcp-isolated.ts`)
  with a **fail-closed** completion-summary + `<N> fail` gate, so a silently-truncated
  run can never pass. Escape hatch: `MINSKY_SKIP_PREPUSH_TESTS=1` (CI stays the
  authoritative gate and cannot be skipped this way).
- **CI** (`.github/workflows/ci.yml`) — the authoritative full suite (main + isolated
  `src/mcp` + hooks), with the same fail-closed gate.

```bash
# Full truncation-safe suite locally (what pre-push runs)
bun scripts/run-tests-gated.ts

# Main suite only (src/mcp excluded) / isolated src/mcp
bun run test
bun run test:mcp-isolated

# Watch mode for development
bun run test:watch
```

#### 3. ESLint Code Quality Layer

**Purpose**: Enforce coding standards and catch potential issues

**Technology**: ESLint with custom rules and TypeScript integration

**Scope**: All TypeScript and JavaScript files

**Custom Rules**:

- `no-real-fs-in-tests`: Prevents real filesystem operations in tests
- `no-jest-patterns`: Enforces Bun test patterns over Jest
- `no-excessive-as-unknown`: Prevents unsafe type casting
- `no-magic-string-duplication`: Reduces hardcoded string duplication

```bash
# Manual execution
bun run lint

# With auto-fix
bun run lint:fix
```

#### 4. ESLint Rule Tooling Layer

**Purpose**: Validate development tooling quality

**Technology**: Dedicated test suite for ESLint rules

**Scope**: Custom ESLint rules and their fixtures

**Behavior**:

- Tests custom ESLint rules against fixtures
- Validates rule behavior and accuracy
- Runs separately from application tests
- Ensures tooling reliability

**Files tested**:

- `src/eslint-rules/__fixtures__/pathological-fs-usage.js`
- `src/eslint-rules/__fixtures__/good-fs-usage.js`
- `src/eslint-rules/fixtures-test.test.js`

```bash
# Manual execution
bun test src/eslint-rules/fixtures-test.test.js --timeout=5000
```

#### 5. Secret Scanning Layer

**Purpose**: Prevent credential leaks and security vulnerabilities

**Technology**: Gitleaks secret detection

**Scope**: All staged files and content

**Protected Secrets**:

- OpenAI API Keys (`sk-proj-`, `sk-`)
- GitHub Personal Access Tokens (`github_pat_`, `ghp_`)
- Anthropic API Keys (`sk-ant-`)
- AWS Access Keys (`AKIA`, `ASIA`)
- Google/GCP API Keys (`AIza`)
- Slack Bot Tokens (`xoxb-`)
- NPM Tokens (`npm_`)
- Private Keys (SSH, SSL, etc.)
- Basic Auth credentials in URLs

```bash
# Manual execution
bun run secrets:scan

# Scan staged files only
gitleaks protect --staged --source .
```

## Development Commands

### Core Development Commands

```bash
# Setup (one-time)
git clone https://github.com/edobry/minsky.git
cd minsky
bun install
brew install gitleaks  # macOS

# Daily development
bun test                    # Run unit tests
bun run test:integration   # Run integration tests (manual)
bun run lint              # Check code quality
bun run lint:fix          # Fix auto-fixable issues
bun run format            # Format code
bun run secrets:scan      # Check for secrets

# Watch mode for active development
bun run test:watch        # Watch unit tests
```

### Commit Workflow

```bash
# Make your changes
git add .

# Commit triggers automatic validation
git commit -m "feat: add new feature"

# If any step fails, fix and try again
# All validations must pass for commit to succeed
```

### Bypassing Hooks (Emergency Only)

```bash
# Skip all pre-commit hooks (NOT RECOMMENDED)
git commit --no-verify -m "emergency commit"

# Better: Fix the specific issue
bun run format  # Fix formatting
bun test       # Fix test failures
bun run lint   # Fix linting issues
```

## Test Organization

### Test Types and Execution

```
Test Categories:
├── Unit Tests (Pre-push + CI)
│   ├── Domain Logic Tests
│   ├── Adapter Tests (CLI, MCP)
│   ├── Utility Tests
│   └── Mock/DI Tests
├── Integration Tests (Manual)
│   ├── AI Service Tests
│   ├── GitHub API Tests
│   └── End-to-end Workflows
└── ESLint Rule Tests (Pre-commit)
    ├── Rule Validation
    └── Fixture Testing
```

### Test Configuration

**Unit Tests** (`bun test` — the full suite):

- Full suite ≈ 8300 tests (~4.3 min); **NOT run on every commit** (mt#2716)
- Mock all external dependencies
- No real filesystem operations
- No real network requests
- Runs at **pre-push** (`bun scripts/run-tests-gated.ts` — truncation-safe + fail-closed) and **CI** (authoritative)

**Integration Tests** (`bun run test:integration`):

- Slower execution (variable)
- May hit real APIs
- Controlled by `RUN_INTEGRATION_TESTS` environment variable
- Run manually only

**ESLint Rule Tests**:

- Validates custom ESLint rules
- Uses fixture files for testing
- Separate from application tests

## Error Handling and Troubleshooting

### Common Issues and Solutions

#### Formatting Failures

**Symptom**: Pre-commit fails at formatting step

**Common Causes**:

- Syntax errors in JavaScript/TypeScript files
- Invalid JSON files
- Corrupted file content

**Solutions**:

```bash
# Check specific file syntax
bun run format --check

# Fix syntax errors manually
# Then retry commit
```

#### Test Failures

**Symptom**: Pre-push (or CI) fails at the test step (mt#2716: the full suite runs at pre-push, not pre-commit)

**Common Causes**:

- Broken tests due to code changes
- Mock configuration issues
- Timing issues in tests

**Solutions**:

```bash
# Reproduce the exact pre-push gate locally (truncation-safe, fail-closed)
bun scripts/run-tests-gated.ts

# Run a specific test file
bun test path/to/specific.test.ts

# Fix failing tests, then retry the push.
# To push past a known flake/WIP: MINSKY_SKIP_PREPUSH_TESTS=1 (CI still runs the full suite)
```

#### Linting Failures

**Symptom**: Pre-commit fails at ESLint step

**Common Causes**:

- Code quality violations
- Custom rule violations
- Type errors

**Solutions**:

```bash
# See specific linting errors
bun run lint

# Auto-fix fixable issues
bun run lint:fix

# Manually fix remaining issues
# Then retry commit
```

#### Secret Detection

**Symptom**: Pre-commit fails at secret scanning step

**Common Causes**:

- Accidentally committed API keys
- Hardcoded credentials in code
- Sensitive data in test files

**Solutions**:

```bash
# See what secrets were detected
gitleaks protect --staged --source .

# Remove secrets from staged files
# Use placeholder values: sk-proj-xxx...xxxxx
# Then retry commit
```

### Performance Optimization

The pre-commit hooks are optimized for fast execution:

- **Full unit suite deferred**: pre-commit runs no full unit suite (mt#2716); it lives at pre-push + CI
- **Incremental linting**: Only staged files are linted
- **Fast static checks**: type-check + lint + repo-integrity guards, not the ~4.3-min suite
- **Smart caching**: Leverages Bun's caching capabilities

**Typical execution times**:

- Code formatting: < 1 second
- TypeScript type check: a few seconds
- ESLint validation: a few seconds
- ESLint rule tests: < 1 second
- Secret scanning: < 1 second
- Full unit suite: NOT run here — see pre-push (mt#2716)

**Total pre-commit time**: seconds, not minutes (the full suite no longer runs at commit time)

## Configuration Files

### Pre-commit Hook Configuration

- **`.husky/pre-commit`**: Main pre-commit script
- **`package.json`**: Test and script definitions
- **`.prettierrc`**: Code formatting configuration
- **`eslint.config.js`**: Linting rules and configuration
- **`.gitleaks.toml`**: Secret scanning configuration

### Key Configuration Sections

**package.json scripts**:

```json
{
  "scripts": {
    "test": "bun test --timeout=15000",
    "test:integration": "RUN_INTEGRATION_TESTS=1 bun test --timeout=30000",
    "lint": "eslint . --quiet",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write \"**/*.{ts,js,json,md}\"",
    "secrets:scan": "gitleaks detect --source ."
  }
}
```

## Benefits and Impact

### Development Experience

- **Automatic Formatting**: No manual formatting work required
- **Fast Feedback**: Issues caught within seconds of commit attempt
- **Consistent Quality**: Same standards enforced for all contributors
- **Error Prevention**: Catches issues before they reach CI/CD

### Code Quality

- **Zero Test Failures**: 100% test passing requirement
- **Consistent Style**: Uniform code formatting
- **Security**: Prevents credential leaks
- **Best Practices**: Custom rules enforce project patterns

### Team Collaboration

- **Predictable Quality**: All committed code meets standards
- **Reduced Review Time**: Quality issues caught before review
- **Consistent Experience**: Same workflow for all developers
- **Documentation**: Well-documented process and troubleshooting

## Future Enhancements

### Planned Improvements

- **Incremental Testing**: Run only tests affected by changes
- **Performance Monitoring**: Track pre-commit execution times
- **Custom Rule Expansion**: Additional project-specific ESLint rules
- **Integration Test Gates**: Selective integration test execution

### Configuration Options

Future releases may include:

- Configurable hook severity levels
- Per-project hook customization
- Performance profiling and optimization
- Enhanced error reporting and guidance

## Contributing to Development Workflow

When modifying the development workflow:

1. **Test Changes Thoroughly**: Ensure hooks work across different scenarios
2. **Maintain Performance**: Keep execution time under 10 seconds
3. **Document Changes**: Update this guide and README
4. **Backwards Compatibility**: Ensure existing workflows continue working
5. **Error Handling**: Provide clear error messages and solutions

For questions about the development workflow or suggestions for improvements, please open an issue or contribute improvements via pull request.
