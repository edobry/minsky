---
name: testing-guide
description: >-
  Testing guidance entry point: what to test, where to put tests, how to mock,
  test architecture overview. Use when writing tests, deciding testing strategy,
  or asking how to test something.
user-invocable: true
---

# Testing Guide

Entry point for all testing decisions. Routes to the right approach based on what you're testing.

## Arguments

Optional: description of what you need to test (e.g., `/testing-guide how to test a new domain service`).

## Quick decision guide

| Question                      | Answer                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Where should I put this test? | Co-locate: `src/domain/[module].test.ts`, `src/adapters/cli/[module].adapter.test.ts`              |
| What should I test?           | Domain logic, error handling, integration points — NOT framework internals, CLI output, filesystem |
| How do I mock?                | `createMock()`, `mockModule()`, `setupTestMocks()` from `src/utils/test-utils/mocking.ts`          |
| Tests failing?                | Use `/debug-tests` skill                                                                           |
| Fixing a bug?                 | Use `/test-driven-bugfix` skill                                                                    |
| Skipped tests?                | Use `/fix-skipped-tests` skill                                                                     |

## Test architecture

Tests are co-located with their modules:

```
src/
├── domain/
│   ├── session.ts
│   ├── session.test.ts              # Domain service tests
│   └── session.commands.test.ts     # Domain command tests
├── adapters/
│   ├── cli/
│   │   └── session.adapter.test.ts  # CLI adapter tests
│   └── mcp/
│       └── session.adapter.test.ts  # MCP adapter tests
```

Complex integration tests go in `tests/` directories when co-location doesn't fit.

## What to test

**Always test:**

- Domain functions with specific inputs and expected outputs
- Error handling and edge cases
- Integration points between modules

**Never test:**

- Framework internals (Commander.js, Winston, etc.)
- Console output formatting
- Interactive terminal interactions
- Filesystem operations directly (use mocks)
- Third-party library internals

## How to mock

```typescript
import { describe, test, expect } from "bun:test";
import { createMock, mockModule, setupTestMocks } from "../utils/test-utils/mocking";

setupTestMocks(); // Automatic cleanup

const mockDep = createMock();
mockModule("../../../src/domain/dep", () => ({ fn: mockDep }));

describe("Module", () => {
  test("should handle case", () => {
    mockDep.mockReturnValue("expected");
    const result = functionUnderTest();
    expect(result).toBe("expected");
  });
});
```

## Requirements

1. **Test domain logic, not interfaces** — test the functions CLI/MCP adapters call, not the adapters themselves
2. **Use centralized testing utilities** — `createMock()` not `jest.fn()`, `mockModule()` not `mock.module()`
3. **Zero placeholder tests** — no `expect(true).toBe(true)`, no `.skip()`, no commented-out tests
4. **Run tests after every change** — batch verify with lint, type-check, test
5. **Follow Arrange-Act-Assert** pattern

## Checklist

- [ ] Testing domain logic, not interfaces
- [ ] Using centralized mocking utilities
- [ ] Arrange-Act-Assert pattern
- [ ] Proper test isolation (no shared mutable state)
- [ ] No direct filesystem operations (using mocks)
- [ ] No placeholder or skipped tests
- [ ] Clear test descriptions
- [ ] Test file in correct architectural layer

## Related rules and skills

- `testing-standards` — test structure, organization, testable design, CLI output testing
- `test-infrastructure` — centralized test utilities (`src/utils/test-utils/`)
- `testing-boundaries` — what to test and what NOT to test
- `bun-test-patterns` — mocking recipes and framework patterns
- `test-expectations` — managing assertions
- `/debug-tests` — systematic failure investigation
- `/test-driven-bugfix` — TDD bug fix methodology
- `/fix-skipped-tests` — zero-tolerance enforcement
