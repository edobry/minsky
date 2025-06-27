# Variable Naming Guide

This guide prevents the variable naming issues that caused runtime errors like "options is not defined", "error is not defined", etc.

## The Problem

We discovered a systematic issue where parameters were prefixed with underscores (`_error`, `_options`, `_params`) but referenced in function bodies without the underscore (`error`, `options`, `params`). This caused runtime "variable is not defined" errors.

### Example of the Problem

```typescript
// ❌ WRONG: Parameter has underscore, but body references without underscore
function example(_options: Options) {
  if (options.debug) {
    // Error: options is not defined
    console.log("Debug mode");
  }
}

// ❌ WRONG: Catch parameter has underscore, but body references without underscore
try {
  doSomething();
} catch (_error) {
  console.log(error.message); // Error: error is not defined
}
```

## The Solution

### 1. Consistent Naming Rules

**Use underscores ONLY for truly unused parameters:**

```typescript
// ✅ CORRECT: Unused parameter with underscore
function handler(_unusedEvent: Event, data: Data) {
  return processData(data);
}

// ✅ CORRECT: Used parameter without underscore
function handler(event: Event, data: Data) {
  console.log(event.type);
  return processData(data);
}
```

**For catch blocks:**

```typescript
// ✅ CORRECT: Used error without underscore
try {
  doSomething();
} catch (error) {
  console.log(error.message);
}

// ✅ CORRECT: Unused error with underscore (rare)
try {
  doSomething();
} catch (_error) {
  // Error is intentionally ignored
  return defaultValue;
}
```

### 2. Function Parameters

```typescript
// ✅ CORRECT: All parameters used, no underscores
function processTask(taskId: string, options: Options) {
  const task = getTask(taskId);
  if (options.validate) {
    validateTask(task);
  }
  return task;
}

// ✅ CORRECT: Mixed used/unused parameters
function processTask(taskId: string, _metadata: Metadata, options: Options) {
  const task = getTask(taskId);
  // _metadata is intentionally unused
  if (options.validate) {
    validateTask(task);
  }
  return task;
}
```

## Prevention Tools

### 1. Automated Checker Script

Run this to find issues:

```bash
bun run scripts/check-variable-naming.ts
```

### 2. Automated Fixer Script

Run this to fix many issues automatically:

```bash
bun run scripts/fix-variable-naming.ts
```

### 3. ESLint Rules

Our `.eslintrc.json` includes rules to prevent these issues:

- `@typescript-eslint/no-unused-vars` with underscore patterns
- `@typescript-eslint/naming-convention` to forbid leading underscores on used variables

### 4. Pre-commit Hook

The pre-commit hook automatically checks for these issues before allowing commits.

## When Underscores ARE Appropriate

1. **Truly unused parameters** (especially in interfaces/callbacks):

   ```typescript
   interface EventHandler {
     onEvent(_event: Event, data: Data): void;
   }
   ```

2. **Destructuring with unused values**:

   ```typescript
   const [first, _second, third] = array;
   ```

3. **Function signatures that must match an interface** but don't use all parameters:
   ```typescript
   // Interface requires both parameters
   const handler: EventHandler = (_event, data) => {
     return processData(data);
   };
   ```

## Migration Strategy

For existing code with these issues:

1. **Run the checker** to identify all issues
2. **Use the fixer script** to automatically resolve most cases
3. **Manual review** for complex cases
4. **Test thoroughly** after changes
5. **Commit incrementally** to track changes

## Common Patterns Fixed

### Catch Blocks

```typescript
// Before: catch (_error) { ... error ... }
// After:  catch (error) { ... error ... }
```

### Function Parameters

```typescript
// Before: function fn(_param) { ... param ... }
// After:  function fn(param) { ... param ... }
```

### Arrow Functions

```typescript
// Before: (_arg) => { ... arg ... }
// After:  (arg) => { ... arg ... }
```

## Error Chain We Fixed

The systematic fix resolved this error progression:

1. "options is not defined" → Fixed workspace.ts
2. "error is not defined" → Fixed catch blocks
3. "params is not defined" → Fixed parameter names
4. "tasks is not defined" → Fixed variable declarations
5. **SUCCESS** → CLI commands work correctly

## Verification

After applying fixes, verify with:

```bash
# Check for remaining issues
bun run scripts/check-variable-naming.ts

# Test the CLI commands that were failing
minsky tasks list
minsky tasks status set 049

# Run the full test suite
bun test
```

## Rule Enforcement

This naming convention is now enforced by:

- ESLint rules in `.eslintrc.json`
- Pre-commit hooks in `.husky/pre-commit`
- Automated scripts in `scripts/`
- Variable naming protocol in `.cursor/rules/variable-naming-protocol.mdc`

Following these guidelines prevents runtime "variable is not defined" errors and ensures consistent, maintainable code.
