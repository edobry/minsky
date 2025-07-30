# Create ESLint rule to forbid real filesystem operations in tests

## Context

## Problem

During Task 176, we discovered multiple test files using real filesystem operations causing:
- Race conditions between concurrent test runs
- Test interference where tests pass individually but fail in test suite  
- Infinite loops due to filesystem conflicts (1.6+ billion ms timeouts)
- Non-deterministic test behavior

## Required ESLint Rule

Create ESLint rule at src/eslint-rules/no-real-fs-in-tests.js that:

### Forbids in Test Files
- fs imports and operations (mkdirSync, writeFileSync, etc.)
- fs/promises operations (mkdir, writeFile, etc.) 
- tmpdir() usage for temp directories
- Real filesystem setup in beforeEach/afterEach

### Allows
- mock.module() for mocking
- In-memory data structures
- Dependency injection with mocked storage

### Success Criteria
1. ESLint rule detects and prevents real filesystem operations in tests
2. Rule integrated into project ESLint configuration
3. Clear error messages with mocking alternatives
4. Prevents the exact patterns that caused issues in Task 176

This directly addresses the root cause of test failures in Task 176 and prevents future filesystem race conditions.

## Requirements

## Solution

## Notes
