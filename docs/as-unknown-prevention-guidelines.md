# 'as unknown' Prevention Guidelines

## Overview

This document provides comprehensive guidelines for preventing excessive use of 'as unknown' type assertions in TypeScript code. These guidelines are based on the analysis from Task #280, which identified 2,728 'as unknown' assertions and successfully reduced them by 74.7%.

## Why 'as unknown' is Dangerous

'as unknown' assertions are dangerous because they:

1. **Mask real type errors**: Hide actual TypeScript compilation errors
2. **Reduce type safety**: Bypass TypeScript's type checking entirely
3. **Create maintenance burden**: Make refactoring and debugging harder
4. **Indicate design issues**: Usually signal missing or incorrect type definitions

<<<<<<< HEAD
## Rules and Best Practices

### 🚫 NEVER Use 'as unknown' For:

#### 1. Return Statements
```typescript
// ❌ WRONG - Masks return type errors
function getUser(): User {
  return null as unknown;
}

// ✅ CORRECT - Proper return type
function getUser(): User | null {
  return null;
}
```

#### 2. Null/Undefined Assignments
```typescript
// ❌ WRONG - Unnecessary casting
const value = null as unknown;

// ✅ CORRECT - Direct assignment
const value = null;
```

#### 3. Property Access
```typescript
// ❌ WRONG - Masks type errors
const sessions = (state as unknown).sessions;

// ✅ CORRECT - Use type guards
if (hasProperty(state, 'sessions')) {
  const sessions = state.sessions;
}
```

### ⚠️ AVOID Using 'as unknown' For:

#### 1. Array Operations
```typescript
// ❌ WRONG - Masks array type errors
const length = (arr as unknown).length;

// ✅ CORRECT - Use type guards
if (isArray(arr)) {
  const length = arr.length;
}
```

#### 2. Service Method Calls
```typescript
// ❌ WRONG - Masks service interface errors
const result = (service as unknown).getData();

// ✅ CORRECT - Use safe service calls
const result = safeServiceCall(service, 'getData');
```

#### 3. Object Method Calls
```typescript
// ❌ WRONG - Masks method call errors
const formatted = (formatter as unknown).format();

// ✅ CORRECT - Use type guards
if (hasProperty(formatter, 'format') && isCallable(formatter.format)) {
  const formatted = formatter.format();
}
```

### 📋 SOMETIMES ACCEPTABLE (Use with Caution):

#### 1. Environment Variables
```typescript
// ❌ AVOID - Better alternatives exist
const port = process.env.PORT as unknown as number;

// ✅ PREFERRED - Use utilities
const port = safeEnvWithDefault('PORT', '3000');
```

#### 2. JSON Parsing
```typescript
// ❌ AVOID - Masks parsing errors
const data = JSON.parse(str) as unknown;

// ✅ PREFERRED - Use safe parsing
const data = safeJsonParse(str);
```

#### 3. Test Mocking (Only in Tests)
```typescript
// ⚠️ ACCEPTABLE - But only in test files
const mockService = {
  getData: jest.fn()
} as unknown as MyService;
```

## Safe Alternatives

### 1. Type Guards
Use type guards from `src/utils/type-guards.ts`:

```typescript
import { hasProperty, isArray, isString } from '@/utils/type-guards';

// Instead of: (obj as unknown).property
if (hasProperty(obj, 'property')) {
  const value = obj.property;
}

// Instead of: (arr as unknown).length
if (isArray(arr)) {
  const length = arr.length;
}
```

### 2. Safe Utilities
Use safe utility functions:

```typescript
import { safeGet, safeJsonParse, safeEnv } from '@/utils/type-guards';

// Instead of: (obj as unknown).key
const value = safeGet(obj, 'key');

// Instead of: JSON.parse(str) as unknown
const data = safeJsonParse(str);

// Instead of: process.env.VAR as unknown
const envVar = safeEnv('VAR');
```

### 3. Domain Type Guards
Use domain-specific type guards:

```typescript
import { DomainTypeGuards } from '@/utils/type-guards';

// Instead of: (obj as unknown).id
if (DomainTypeGuards.isSessionLike(obj)) {
  const id = obj.id; // TypeScript knows obj has id: string
}
```

## ESLint Rule Configuration

The custom ESLint rule `custom/no-excessive-as-unknown` helps prevent these patterns:
=======
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
    "custom/no-excessive-as-unknown": ["error", {
      "allowInTests": false,
      "allowPatterns": [
        "process\\.env\\[.*\\] as unknown",
        "import\\(.*\\) as unknown"
      ],
      "maxAssertionsPerFile": 5
    }]
  }
}
```

### Rule Severity Levels:

- **ERROR**: Critical patterns (return statements, null/undefined)
- **WARN**: High-risk patterns (property access, method calls)
- **INFO**: Medium-risk patterns (environment variables, JSON parsing)

## Common Patterns and Solutions

### 1. State Management
```typescript
// ❌ WRONG
const sessions = (state as unknown).sessions;

// ✅ CORRECT
interface AppState {
  sessions: Session[];
}

const sessions = (state as AppState).sessions;
// Or better: use proper typing from the start
```

### 2. API Responses
```typescript
// ❌ WRONG
const user = response.data as unknown;

// ✅ CORRECT
interface ApiResponse<T> {
  data: T;
}

const user = (response as ApiResponse<User>).data;
```

### 3. Configuration Objects
```typescript
// ❌ WRONG
const dbPort = (config as unknown).database.port;

// ✅ CORRECT
interface Config {
  database: {
    port: number;
  };
}

const dbPort = (config as Config).database.port;
```

### 4. Error Handling
```typescript
// ❌ WRONG
const message = (error as unknown).message;

// ✅ CORRECT
if (DomainTypeGuards.isErrorLike(error)) {
  const message = error.message;
}
=======
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
