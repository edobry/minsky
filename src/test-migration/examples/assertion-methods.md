# Assertion Method Migration Guide

This document provides a reference for migrating Jest/Vitest assertion methods to Bun's test framework equivalents.

## Common Assertion Methods

| Jest/Vitest Method | Bun Equivalent | Notes |
|-------------------|----------------|-------|
| `expect(x).toBe(y)` | `expect(x).toBe(y)` | Direct equivalent |
| `expect(x).toEqual(y)` | `expect(x).toEqual(y)` | Direct equivalent |
| `expect(x).toContain(y)` | `expect(x).toContain(y)` | Direct equivalent |
| `expect(x).toBeTruthy()` | `expect(x).toBeTruthy()` | Direct equivalent |
| `expect(x).toBeFalsy()` | `expect(x).toBeFalsy()` | Direct equivalent |
| `expect(x).toMatch(regex)` | `expect(x.match(regex)).toBeTruthy()` | No direct equivalent |
| `expect(fn).toThrow()` | `expect(() => fn()).toThrow()` | Similar, but always needs a function wrapper |
| `expect(promise).resolves.toBe(x)` | `expect(promise).resolves.toBe(x)` | Direct equivalent |
| `expect(promise).rejects.toThrow()` | `expect(promise).rejects.toThrow()` | Direct equivalent |

## Custom Assertion Helpers

For missing assertion methods in Bun, we can implement custom helpers:

```typescript
// src/utils/test-utils/assertions.ts

/**
 * Custom matcher to replicate Jest's toMatch functionality
 * @param value The string to test
 * @param pattern The regex pattern to match against
 */
export function expectToMatch(value: string, pattern: RegExp): void {
  const result = value.match(pattern);
  expect(result).toBeTruthy();
}

/**
 * Custom matcher to replicate Jest's toHaveLength functionality
 * @param value The array or string to test
 * @param length The expected length
 */
export function expectToHaveLength(value: any, length: number): void {
  expect(value.length).toBe(length);
}
```

## Usage Examples

### Before (Jest/Vitest)

```typescript
test("string matches pattern", () => {
  expect("hello world").toMatch(/world/);
});
```

### After (Bun)

```typescript
// Option 1: Direct conversion
test("string matches pattern", () => {
  expect("hello world".match(/world/)).toBeTruthy();
});

// Option 2: Using custom helper
import { expectToMatch } from "../utils/test-utils/assertions.js";

test("string matches pattern", () => {
  expectToMatch("hello world", /world/);
});
```

## Implementation Plan

As we discover assertion method differences during migration, we will:

1. Document the difference in this file
2. Implement custom helpers in `src/utils/test-utils/assertions.ts` if needed
3. Update test migration documentation with recommended patterns 
