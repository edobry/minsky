# Implement test coverage enforcement in pre-commit hooks

## Context

Add test coverage checking to pre-commit hooks to prevent engineers from skipping tests and ensure minimum coverage thresholds are maintained before commits are allowed

## Requirements

### Core Requirements

1. **Test Coverage Measurement**: Implement test coverage collection and reporting
2. **Coverage Thresholds**: Define minimum coverage thresholds (e.g., 80% line coverage)
3. **Pre-commit Integration**: Add coverage check to existing pre-commit hooks
4. **Test Execution Enforcement**: Ensure all tests are run and none are skipped
5. **Clear Error Messages**: Provide actionable feedback when coverage is insufficient

### Technical Requirements

1. **Coverage Tool Integration**: Use bun's built-in coverage or integrate appropriate tool
2. **Threshold Configuration**: Make coverage thresholds configurable
3. **Exclusion Patterns**: Allow excluding specific files/directories from coverage requirements
4. **Performance**: Coverage check should complete in reasonable time (< 30 seconds)
5. **CI/CD Compatibility**: Ensure coverage checks work in both local and CI environments

### Quality Requirements

1. **Zero Tolerance for Skipped Tests**: Pre-commit hook must fail if any tests are skipped
2. **Coverage Regression Prevention**: Block commits that reduce overall coverage
3. **Granular Reporting**: Show coverage by file/directory for debugging
4. **Integration with Existing Workflow**: Work seamlessly with current pre-commit setup

## Solution

### Phase 1: Coverage Infrastructure

1. **Coverage Collection Setup**

   - Configure bun test coverage collection
   - Create coverage reporting scripts
   - Define coverage output formats (JSON, HTML, terminal)

2. **Threshold Configuration**
   - Add coverage thresholds to package.json or dedicated config file
   - Support different thresholds for different file types/directories
   - Include configuration for line, branch, and function coverage

### Phase 2: Pre-commit Integration

1. **Hook Enhancement**

   - Modify existing pre-commit hook to include coverage check
   - Add test execution with coverage collection
   - Implement threshold validation logic

2. **Error Handling**
   - Create clear error messages for coverage failures
   - Show which files need more coverage
   - Provide suggestions for improving coverage

### Phase 3: Quality Enforcement

1. **Skipped Test Detection**

   - Parse test output to detect skipped/pending tests
   - Fail pre-commit if any tests are marked as skipped
   - Exception handling for legitimate skip scenarios (e.g., integration tests)

2. **Regression Prevention**
   - Compare current coverage with previous coverage
   - Block commits that reduce coverage below threshold
   - Generate coverage diff reports

### Phase 4: Developer Experience

1. **Fast Feedback**

   - Optimize coverage collection for speed
   - Cache coverage data where possible
   - Provide progress indicators during coverage collection

2. **Debugging Tools**
   - Coverage report generation commands
   - File-specific coverage queries
   - Integration with development workflow

## Implementation Plan

### Files to Modify/Create

1. **`.husky/pre-commit`** - Add coverage check step
2. **`scripts/check-coverage.js`** - Coverage validation script
3. **`package.json`** - Coverage configuration and thresholds
4. **`justfile`** - Coverage-related commands
5. **Documentation** - Update README with coverage requirements

### Configuration Structure

```json
{
  "coverage": {
    "thresholds": {
      "global": {
        "lines": 80,
        "branches": 75,
        "functions": 80,
        "statements": 80
      },
      "perFile": {
        "lines": 70,
        "branches": 65
      }
    },
    "exclude": ["**/*.test.ts", "**/migrations/**", "**/build/**"]
  }
}
```

### Pre-commit Hook Flow

1. Run all tests with coverage collection
2. Parse test results for skipped tests
3. Validate coverage against thresholds
4. Generate coverage report
5. Fail commit if requirements not met

## Notes

### Alignment with Existing Rules

- **no-skipped-tests rule**: This task directly implements the zero tolerance policy for skipped tests
- **testing-boundaries rule**: Coverage enforcement supports proper test focus
- **test-driven-bugfix rule**: Coverage helps ensure bug fixes include tests

### Risk Considerations

1. **Performance Impact**: Coverage collection may slow down pre-commit hooks
2. **False Positives**: Some legitimate skipped tests (integration tests) need handling
3. **Developer Friction**: Too strict thresholds may frustrate developers
4. **Legacy Code**: Existing code may not meet new coverage requirements

### Success Metrics

1. **Zero skipped tests** in committed code
2. **Consistent coverage levels** above defined thresholds
3. **Developer adoption** without excessive friction
4. **Reduced bug rates** due to better test coverage
