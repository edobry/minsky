# Disallow Dynamic Imports

## Rule Name: no-dynamic-imports

## Description

Avoid using dynamic `import()` statements in TypeScript code. Prefer static imports for better compile-time analysis, type checking, and code clarity.

Dynamic imports can obscure dependencies, make refactoring harder, and can sometimes lead to unexpected behavior or performance issues if not managed carefully.

## Rationale

- **Static Analysis**: Static imports allow tools to better understand the module graph.
- **Type Safety**: Improves the ability of the TypeScript compiler to check types across modules.
- **Predictability**: Makes code flow easier to follow and debug.

## Exceptions

There might be rare, specific cases where dynamic imports are necessary (e.g., conditional loading of large optional modules, plugins). Such exceptions should be well-justified and documented.

## How to Fix

Replace dynamic imports:

```typescript
// AVOID
const myModule = await import("./myModule");
myModule.doSomething();
```

With static imports:

```typescript
// PREFER
import { doSomething } from "./myModule";
doSomething();
```
