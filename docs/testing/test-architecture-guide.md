# Test Architecture Guide

## Overview

This guide explains the Minsky project's test architecture, which is organized by **architectural layer** rather than interface type. Tests are **co-located** with their modules following standard TypeScript/JavaScript conventions.

## Core Principle

**Tests are organized by what they test, not how they're accessed.**

- Domain logic tests are co-located with domain modules
- Adapter tests are co-located with adapter modules  
- Integration tests use `tests/` directories only when they don't fit simple co-location

## Test Categories

### Domain Service Tests

**Purpose**: Test core domain services and business logic  
**Location**: Co-located with domain modules (e.g., `src/domain/session.test.ts`)  
**Naming**: `[module].test.ts`

```typescript
// src/domain/session.test.ts
describe("Session Domain Service", () => {
  test("createSession creates session with task ID", () => {
    // Test business logic, data operations, service orchestration
  });
});
```

### Domain Command Tests

**Purpose**: Test `*FromParams` functions (business logic layer)  
**Location**: Co-located with domain modules (e.g., `src/domain/session.commands.test.ts`)  
**Naming**: `[module].commands.test.ts`

```typescript
// src/domain/session.commands.test.ts
describe("Session Domain Commands", () => {
  test("getSessionFromParams validates and retrieves session", () => {
    // Test parameter validation, business logic, service orchestration
  });
});
```

### Adapter Tests

**Purpose**: Test interface-specific concerns only  
**Location**: Co-located with adapter modules  
**Naming**: `[module].adapter.test.ts`

```typescript
// src/adapters/cli/session.adapter.test.ts
describe("Session CLI Adapter", () => {
  test("formats session output correctly", () => {
    // Test CLI-specific formatting, command registration
  });
});
```

### Integration Tests

**Purpose**: Test complex workflows that span multiple modules  
**Location**: `tests/` directories when co-location doesn't fit  
**Naming**: `[feature]-integration.test.ts`

```typescript
// src/domain/tests/session-lifecycle-integration.test.ts
describe("Session Lifecycle Integration", () => {
  test("complete session workflow", () => {
    // Test end-to-end workflows, cross-module interactions
  });
});
```

## Test Placement Decision Tree

```
What are you testing?
├── Core domain service methods? 
│   └── Co-locate: src/domain/[module].test.ts
├── *FromParams functions (command logic)?
│   └── Co-locate: src/domain/[module].commands.test.ts
├── CLI adapter concerns?
│   └── Co-locate: src/adapters/cli/[module].adapter.test.ts
├── MCP adapter concerns?
│   └── Co-locate: src/adapters/mcp/[module].adapter.test.ts
└── Complex integration workflow?
    └── Use tests/: src/[area]/tests/[feature]-integration.test.ts
```

## Benefits of Co-Location

- **Easy to find**: Tests are right next to the code they test
- **Clear ownership**: Immediately obvious which tests belong to which modules
- **Follows conventions**: Standard TypeScript/JavaScript project pattern
- **Single source of truth**: Each module has one clear test file
- **Easy maintenance**: Changes to code and tests happen together
- **Better IDE support**: Tests appear next to source files in file explorers

## Migration Guidelines

### From __tests__ Structure

When moving tests from the old `__tests__/` structure:

1. **Identify what the test actually tests** (not where it was located)
2. **Choose co-location target** based on the module being tested
3. **Update import paths** to use relative paths from new location
4. **Rename file** to follow new conventions

### Common Migrations

- `__tests__/domain/commands/session.test.ts` → `src/domain/session.commands.test.ts`
- `__tests__/adapters/cli/session.test.ts` → `src/adapters/cli/session.adapter.test.ts`
- `src/domain/__tests__/session.test.ts` → `src/domain/session.test.ts` (already correct)

## Import Path Patterns

### Co-located Tests
```typescript
// src/domain/session.test.ts
import { SessionService } from "./session";
import { createMock } from "../utils/test-utils/mocking";
```

### Integration Tests
```typescript
// src/domain/tests/session-integration.test.ts
import { SessionService } from "../session";
import { createMock } from "../../utils/test-utils/mocking";
```

## Common Pitfalls to Avoid

- ❌ **Don't create bug-specific test files** - add bug tests to existing module tests
- ❌ **Don't fragment tests by feature** - keep all tests for a module together
- ❌ **Don't organize by interface** when testing domain logic
- ❌ **Don't use `tests/` for simple unit tests** - reserve for complex integration

## Example Directory Structure

```
src/
├── domain/
│   ├── session.ts
│   ├── session.test.ts              # Domain service tests
│   ├── session.commands.test.ts     # Domain command tests
│   ├── tasks.ts
│   ├── tasks.test.ts
│   ├── tasks.commands.test.ts
│   └── tests/                       # Complex integration tests only
│       └── session-lifecycle-integration.test.ts
├── adapters/
│   ├── cli/
│   │   ├── session.ts
│   │   ├── session.adapter.test.ts  # CLI adapter tests
│   │   ├── tasks.ts
│   │   └── tasks.adapter.test.ts
│   └── mcp/
│       ├── session.ts
│       ├── session.adapter.test.ts  # MCP adapter tests
│       └── tests/                   # Complex MCP integration tests
│           └── tools-integration.test.ts
└── utils/
    ├── logger.ts
    └── logger.test.ts               # Utility tests
```

## Testing Best Practices

1. **Test the public interface** - focus on what the module exposes
2. **Use descriptive test names** - explain what scenario is being tested
3. **Group related tests** - use `describe` blocks to organize test suites
4. **Mock external dependencies** - use centralized mocking utilities
5. **Keep tests focused** - each test should verify one specific behavior
6. **Include edge cases** - test error conditions and boundary cases

## Related Documentation

- [test-organization.mdc](mdc:.cursor/rules/test-organization.mdc) - File organization rules
- [bun-test-patterns.mdc](mdc:.cursor/rules/bun-test-patterns.mdc) - Test implementation patterns
- [testing-boundaries.mdc](mdc:.cursor/rules/testing-boundaries.mdc) - What to test vs avoid 
