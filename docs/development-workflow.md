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
│           2. 🧪 Unit Test Suite (Bun Test)                  │
│  • Runs all 1,400+ unit tests                               │
│  • Zero tolerance for failures                              │
│  • Fast execution (~2 seconds)                              │
│  • Blocks commit on any test failure                        │
└─────────────────────┬───────────────────────────────────────┘
                      │ ✅ All tests passing
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

#### 2. Unit Test Suite Layer

**Purpose**: Comprehensive validation of application logic

**Technology**: Bun test runner with zero failure tolerance

**Scope**: All unit tests excluding integration tests

**Behavior**:

- Runs complete test suite (1,400+ tests)
- Fast execution optimized for pre-commit use
- Blocks commit on any test failure
- Provides detailed failure information

**Test Categories**:

- Domain logic tests
- Adapter tests (CLI, MCP)
- Utility function tests
- Mock and DI tests

```bash
# Manual execution
bun test --timeout=15000

# With verbose output
bun test --verbose

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
├── Unit Tests (Pre-commit)
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

**Unit Tests** (`bun test`):

- Fast execution (< 3 seconds)
- Mock all external dependencies
- No real filesystem operations
- No real network requests
- Runs on every commit

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

**Symptom**: Pre-commit fails at test step

**Common Causes**:

- Broken tests due to code changes
- Mock configuration issues
- Timing issues in tests

**Solutions**:

```bash
# Run tests with verbose output
bun test --verbose

# Run specific test file
bun test path/to/specific.test.ts

# Fix failing tests
# Then retry commit
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

- **Test parallelization**: Tests run in parallel where possible
- **Incremental linting**: Only staged files are linted
- **Efficient test patterns**: Fast, isolated unit tests
- **Smart caching**: Leverages Bun's caching capabilities

**Typical execution times**:

- Code formatting: < 1 second
- Unit test suite: ~2 seconds
- ESLint validation: < 1 second
- ESLint rule tests: < 1 second
- Secret scanning: < 1 second

**Total pre-commit time**: ~5-7 seconds

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
