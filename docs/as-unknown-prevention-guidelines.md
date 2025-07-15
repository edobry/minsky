# 'as unknown' Prevention Guidelines

## Overview

This document provides comprehensive guidelines for preventing excessive use of 'as unknown' type assertions in TypeScript code. These guidelines are based on the analysis from Task #280, which identified 2,728 'as unknown' assertions and successfully reduced them by 80.6%.

## Why 'as unknown' is Dangerous

'as unknown' assertions are dangerous because they:

1. **Mask real type errors**: Hide actual TypeScript compilation errors
2. **Reduce type safety**: Bypass TypeScript's type checking entirely
3. **Create maintenance burden**: Make refactoring and debugging harder
4. **Indicate design issues**: Usually signal missing or incorrect type definitions

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

```json
{
  "rules": {
    "custom/no-excessive-as-unknown": ["error", {
      "allowInTests": false,
      "allowPatterns": ["specific-pattern-regex"],
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
```

## Migration Strategy

### Step 1: Identify Patterns
Run the analysis tool to identify all 'as unknown' assertions:

```bash
bun run scripts/analyze-as-unknown.ts
```

### Step 2: Categorize by Risk
Use the ESLint rule to categorize assertions by severity:

```bash
bun run lint | grep "no-excessive-as-unknown"
```

### Step 3: Fix Critical Patterns First
1. **Return statements**: Add proper return types
2. **Null/undefined**: Remove unnecessary casts
3. **Property access**: Add type guards or interfaces

### Step 4: Fix High-Risk Patterns
1. **Array operations**: Use type guards
2. **Service calls**: Use safe service utilities
3. **Object methods**: Add proper interfaces

### Step 5: Address Medium-Risk Patterns
1. **Environment variables**: Use safe utilities
2. **JSON parsing**: Use safe parsing functions
3. **Module imports**: Add proper type definitions

## Testing Guidelines

### Acceptable Test Patterns
```typescript
// ✅ ACCEPTABLE - Mock objects in tests
const mockService = {
  getData: jest.fn().mockResolvedValue('test')
} as unknown as MyService;

// ✅ ACCEPTABLE - Test data setup
const testData = {
  id: '123',
  name: 'Test'
} as unknown as ComplexType;
```

### Unacceptable Test Patterns
```typescript
// ❌ WRONG - Even in tests
const result = (service as unknown).getData();

// ✅ CORRECT - Use proper mocking
const mockService = createMockService();
const result = mockService.getData();
```

## Performance Considerations

### Type Guards vs Assertions
Type guards provide runtime safety but have performance overhead:

```typescript
// Faster but unsafe
const value = (obj as unknown).property;

// Slightly slower but safe
const value = hasProperty(obj, 'property') ? obj.property : undefined;
```

### When Performance Matters
In performance-critical code, consider:
1. **Proper typing at the source** (best solution)
2. **One-time type validation** at boundaries
3. **Assertion functions** for guaranteed types

## Code Review Checklist

### For Reviewers:
- [ ] Are there any 'as unknown' assertions?
- [ ] Can they be replaced with type guards?
- [ ] Are proper interfaces defined?
- [ ] Is the ESLint rule passing?
- [ ] Are test assertions justified?

### For Developers:
- [ ] Did I try proper typing first?
- [ ] Is this the simplest solution?
- [ ] Am I masking a real type error?
- [ ] Could this break at runtime?
- [ ] Is there a safe utility I can use?

## Tooling

### Available Tools:
1. **ESLint Rule**: `custom/no-excessive-as-unknown`
2. **Type Guards**: `src/utils/type-guards.ts`
3. **Analysis Script**: `scripts/analyze-as-unknown.ts`
4. **Codemod**: `codemods/ast-type-cast-fixer.ts`

### Integration:
- Pre-commit hooks catch new violations
- CI/CD pipeline fails on critical patterns
- Code review process includes type safety checks

## Conclusion

The goal is not to eliminate all 'as unknown' assertions, but to:
1. **Reduce dangerous patterns** that mask real errors
2. **Improve type safety** through proper typing
3. **Maintain code quality** with consistent practices
4. **Prevent regression** through tooling and guidelines

By following these guidelines, we can maintain TypeScript's type safety benefits while avoiding the pitfalls of excessive type assertions.

## Further Reading

- [TypeScript Type Guards](https://www.typescriptlang.org/docs/handbook/advanced-types.html#type-guards-and-differentiating-types)
- [ESLint Custom Rules](https://eslint.org/docs/developer-guide/working-with-rules)
- [Type Safety Best Practices](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html) 
