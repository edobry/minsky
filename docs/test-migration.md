# Test Migration Tools

This directory contains tools for analyzing and migrating tests from Jest/Vitest patterns to Bun test patterns.

## Overview

The test migration process consists of two main steps:

1. **Analysis**: First, run the `test-analyzer.ts` script to analyze all test files in the codebase. This will generate a detailed report about the tests, including their mocking patterns, framework dependencies, and migration difficulty.

2. **Migration**: Then, run the `test-migration.ts` script to apply transformation rules to the test files. This script supports various options for filtering tests, verifying functionality, and generating reports.

## Test Analyzer

The test analyzer script scans your codebase for test files and analyzes their patterns to determine how difficult they would be to migrate to Bun's native testing APIs.

### Usage

```bash
bun src/scripts/test-analyzer.ts [--output-file=<path>] [--target-dir=<dir>]
```

Options:

- `--output-file=<path>`: Path to write the JSON report (default: `test-analysis/test-analysis-report.json`)
- `--target-dir=<dir>`: Directory to analyze (default: `src`)

### Output

The analyzer generates two files:

- A JSON report with detailed analysis of each test file
- A Markdown summary with high-level statistics and recommendations

Example report summary:

```markdown
# Test Analysis Report

Generated: 5/21/2025, 11:36:18 AM

Total test files analyzed: **46**

## Test Classification Summary

### By Mocking Complexity

| Complexity | Count | Percentage |
| ---------- | ----- | ---------- |
| low        | 35    | 76.1%      |
| medium     | 8     | 17.4%      |
| high       | 3     | 6.5%       |

### By Framework Dependency

| Framework | Count | Percentage |
| --------- | ----- | ---------- |
| jest      | 0     | 0.0%       |
| vitest    | 0     | 0.0%       |
| bun       | 45    | 97.8%      |
| mixed     | 0     | 0.0%       |
| none      | 1     | 2.2%       |
```

## Test Migration

The test migration script applies transformation rules to test files to convert Jest/Vitest patterns to Bun patterns.

### Usage

```bash
bun src/scripts/test-migration.ts [options]
```

Options:

- `--analysis-file=<path>`: Path to the test analysis JSON file (default: `test-analysis/test-analysis-report.json`)
- `--target=<path>`: Specific test file or directory to migrate
- `--difficulty=<level>`: Only migrate tests with specified difficulty (easy, medium, hard)
- `--dry-run`: Preview changes without applying them
- `--backup`: Create backup files before migration (.bak extension)
- `--verify`: Run tests before and after migration to verify functionality

### Examples

1. Run analysis first:

   ```bash
   bun src/scripts/test-analyzer.ts
   ```

2. Perform a dry run on easy tests:

   ```bash
   bun src/scripts/test-migration.ts --difficulty=easy --dry-run
   ```

3. Migrate a specific directory with verification:

   ```bash
   bun src/scripts/test-migration.ts --target=src/utils --verify
   ```

4. Migrate all tests with backups:
   ```bash
   bun src/scripts/test-migration.ts --backup
   ```

## Transformation Rules

The migration script applies the following transformations:

1. **Import Statements**

   - `import X from 'jest'` → `import X from 'bun:test'`
   - `import X from 'vitest'` → `import X from 'bun:test'`
   - Add `import { mock } from 'bun:test'` if needed

2. **Mock Functions**

   - `jest.fn()` → `mock.fn()`
   - `vitest.fn()` → `mock.fn()`

3. **Module Mocking**

   - `jest.mock('./module')` → `mock.module('./module')`
   - `vitest.mock('./module')` → `mock.module('./module')`

4. **Spies**
   - `jest.spyOn(obj, 'method')` → `createSpyOn(obj, 'method')`
   - `vitest.spyOn(obj, 'method')` → `createSpyOn(obj, 'method')`
   - Add `import { createSpyOn } from '../../../utils/test-utils/mocking'` if needed

## Verification

The `--verify` option runs tests before and after migration to ensure functionality is preserved. If a test fails after migration, the script will automatically restore the file from its backup.

## Reports

The migration script generates two report files:

- A JSON report with detailed information about each migrated file
- A Markdown summary with statistics and results

Example migration report:

```markdown
# Test Migration Report

Generated: 5/21/2025, 2:45:30 PM

## Migration Summary

- Total Files: 10
- Successfully Migrated: 9
- Failed Migrations: 1

## Configuration

- Dry Run: No
- Create Backups: Yes
- Verify Tests: Yes
- Target Path: src/utils
- Difficulty Filter: easy
```

## Best Practices

1. **Always start with analysis** to understand the scope of the migration.
2. **Begin with easy tests** for quick wins and to validate the approach.
3. **Use --dry-run first** to preview changes before applying them.
4. **Always use --backup** when applying changes to allow for recovery.
5. **Consider --verify** for critical tests to ensure functionality is preserved.
6. **Migrate tests in small batches** rather than all at once.
