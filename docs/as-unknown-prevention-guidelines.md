# 'as unknown' Prevention Guidelines

## Overview

This document provides comprehensive guidelines for preventing excessive use of 'as unknown' type assertions in TypeScript code. These guidelines are based on the analysis from Task #280, which identified 2,728 'as unknown' assertions and successfully reduced them by 74.7%.

## Why 'as unknown' is Dangerous

'as unknown' assertions are dangerous because they:

1. **Mask real type errors**: Hide actual TypeScript compilation errors
2. **Reduce type safety**: Bypass TypeScript's type checking entirely
3. **Create maintenance burden**: Make refactoring and debugging harder
4. **Indicate design issues**: Usually signal missing or incorrect type definitions

## Rule: Never Use These Patterns

### ❌ Critical Patterns (Always Forbidden)

```typescript
// Never cast return values
function getData(): any {
  return someData as unknown; // ❌ NEVER
}

// Never cast null/undefined
const result = null as unknown; // ❌ NEVER
const value = undefined as unknown; // ❌ NEVER
```

### ❌ Dangerous Patterns (Usually Wrong)

```typescript
// Property access through unknown
const property = (someObject as unknown).property; // ❌ DANGEROUS

// Method calls through unknown
const result = (someService as unknown).method(); // ❌ DANGEROUS

// Array operations through unknown
const length = (someArray as unknown).length; // ❌ DANGEROUS
const items = (someArray as unknown).map(fn); // ❌ DANGEROUS
```

## Better Alternatives

### ✅ Use Type Guards Instead

```typescript
// Instead of: (someValue as unknown).property
// Use type guards:
import { hasProperty } from '../utils/type-guards';

if (hasProperty(someValue, 'property')) {
  const property = someValue.property; // ✅ Type-safe
}
```

### ✅ Use Utility Functions

```typescript
// Instead of: (someObject as unknown).property
// Use safe property access:
import { safeGet } from '../utils/type-guards';

const property = safeGet(someObject, 'property'); // ✅ Safe
```

### ✅ Use Proper Type Definitions

```typescript
// Instead of: (options as unknown).timeout
// Define proper interfaces:
interface Options {
  timeout?: number;
  retries?: number;
}

function processOptions(options: Options) {
  const timeout = options.timeout || 5000; // ✅ Type-safe
}
```

## Specific Use Cases and Solutions

### Environment Variables

```typescript
// ❌ Bad
const port = process.env.PORT as unknown as number;

// ✅ Good
import { EnvUtils } from '../utils/type-guards';
const port = EnvUtils.getNumber('PORT', 3000);
```

### JSON Parsing

```typescript
// ❌ Bad
const data = JSON.parse(jsonString) as unknown as MyType;

// ✅ Good
import { JsonUtils } from '../utils/type-guards';
const data = JsonUtils.safeParse(jsonString, isMyType);
```

### Service Method Calls

```typescript
// ❌ Bad
const result = (someService as unknown).process(data);

// ✅ Good
import { ServiceUtils } from '../utils/type-guards';
const result = ServiceUtils.safeCall(someService, 'process', data);
```

### Configuration Objects

```typescript
// ❌ Bad
const setting = (config as unknown).setting;

// ✅ Good
import { ConfigUtils } from '../utils/type-guards';
const setting = ConfigUtils.get(config, 'setting', defaultValue);
```

### Array Operations

```typescript
// ❌ Bad
const items = (someArray as unknown).map(fn);

// ✅ Good
import { ArrayUtils } from '../utils/type-guards';
const items = ArrayUtils.safeMap(someArray, fn);
```

## ESLint Integration

The project includes a custom ESLint rule `custom/no-excessive-as-unknown` that detects dangerous patterns:

```json
{
  "rules": {
    "custom/no-excessive-as-unknown": ["warn", {
      "allowInTests": true,
      "allowedPatterns": [
        "process\\.env\\[.*\\] as unknown",
        "import\\(.*\\) as unknown"
      ]
    }]
  }
}
```

### Rule Severity Levels

- **ERROR**: Critical patterns that should never be used
- **WARN**: Dangerous patterns that usually indicate typing issues
- **INFO**: Risky patterns that may be acceptable in some contexts

## When 'as unknown' Might Be Acceptable

### Legitimate Use Cases (Rare)

1. **Type bridging with proper validation**:
```typescript
function bridgeTypes<T>(value: unknown, validator: (v: unknown) => v is T): T {
  if (validator(value)) {
    return value;
  }
  throw new Error('Invalid type');
}
```

2. **Low-level library integration**:
```typescript
// When interfacing with untyped libraries
const result = (externalLibrary as unknown as LibraryInterface).method();
```

3. **Test utilities and mocking**:
```typescript
// In test files only
const mockService = { method: jest.fn() } as unknown as ServiceInterface;
```

## Migration Strategy

### Step 1: Identify Violations

Run ESLint to find all 'as unknown' violations:

```bash
bun run lint
```

### Step 2: Categorize by Risk

- **Critical**: Fix immediately (return statements, null/undefined)
- **High**: Fix with proper interfaces and type guards
- **Medium**: Consider if legitimate or can be improved

### Step 3: Use Automated Tools

Use the AST codemod to automatically fix common patterns:

```bash
bun run codemods/ast-type-cast-fixer.ts
```

### Step 4: Manual Review

Review remaining assertions to ensure they're legitimate or can be improved with proper typing.

## Development Workflow

### For New Code

1. **Never start with 'as unknown'**: Always try proper typing first
2. **Use type guards**: Import and use utilities from `src/utils/type-guards.ts`
3. **Define interfaces**: Create proper type definitions for your data structures
4. **Validate at boundaries**: Use type guards when receiving external data

### For Existing Code

1. **Run ESLint**: Check for violations before committing
2. **Fix critical patterns**: Address errors immediately
3. **Improve gradually**: Replace dangerous patterns with safer alternatives
4. **Test thoroughly**: Ensure type safety improvements don't break functionality

## Performance Considerations

Using proper type guards and validation has minimal performance impact compared to the debugging and maintenance costs of 'as unknown' assertions:

- **Type guards**: Add minimal runtime overhead
- **Utility functions**: Can be optimized by bundlers
- **Proper types**: Zero runtime cost, compile-time benefits

## Tools and Utilities

### ESLint Rule

- Location: `src/eslint-rules/no-excessive-as-unknown.js`
- Configuration: `eslint.config.js`
- Provides auto-fixing for simple cases

### Type Guards and Utilities

- Location: `src/utils/type-guards.ts`
- Provides safe alternatives to 'as unknown'
- Includes utilities for common use cases

### AST Codemod

- Location: `codemods/ast-type-cast-fixer.ts`
- Automatically fixes common patterns
- Maintains comprehensive documentation and tests

## Conclusion

The goal is to eliminate dangerous 'as unknown' assertions while maintaining type safety and code quality. By following these guidelines and using the provided tools, you can write more maintainable, type-safe TypeScript code.

Remember: **If you need 'as unknown', there's usually a better way to solve the problem with proper typing.** 
