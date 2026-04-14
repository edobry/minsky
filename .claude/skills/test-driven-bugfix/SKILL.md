---
name: test-driven-bugfix
description: >-
  Fix bugs using test-driven methodology: write a failing test that reproduces
  the bug first, then fix the code to make it pass. Use when fixing any bug,
  especially data integrity issues, race conditions, or behavioral regressions.
user-invocable: true
---

# Test-Driven Bug Fix

Fix bugs by writing a failing test first, then making it pass. Never fix code without a test that proves the bug exists.

## Arguments

Optional: task ID, PR number, or description of the bug. If omitted, apply to the current bug being discussed.

## Process

### 1. Understand the bug

Before writing anything, clearly articulate:

- **What happens**: The observable symptom (e.g., "session record vanishes from DB")
- **What should happen**: The expected behavior (e.g., "session record persists until explicitly deleted")
- **Reproduction conditions**: When/how it occurs (e.g., "after idle period >10s between MCP operations")

Read the relevant source code to understand the code path. Don't guess — trace the actual execution.

### 2. Write a failing test

Write a test that:

- **Reproduces the exact bug** — not a similar scenario, the actual failure mode
- **Fails in the same way** the bug manifests — the assertion should match the symptom
- **Documents the bug** in comments — reference task/issue numbers, describe steps to reproduce
- **Uses the project's testing patterns** — DI fakes, no real resources (per project hermeticity rules)

```typescript
describe("BugDescription", () => {
  // Bug mt#NNN: <description>
  // Reproduction: <steps>
  it("should <expected behavior> (currently fails due to <root cause>)", () => {
    // Set up the scenario that triggers the bug
    // Assert the correct behavior (this will fail until fixed)
  });
});
```

### 3. Verify the test fails correctly

Run the test and confirm:

- It **fails** (if it passes, the test doesn't reproduce the bug — go back to step 1)
- The failure message describes the actual symptom
- Document the exact error output

### 4. Fix the implementation

Now and only now, fix the code:

- Make **minimal changes** to make the test pass
- Don't add features, refactor, or "improve" beyond the fix
- If multiple independent issues contribute to the bug, fix them in the same commit but test each one

### 5. Verify all tests pass

- Run the previously failing test — it should now pass
- Run the full test suite (`bun run validate-all`) — no regressions
- If new failures appear, they reveal related issues — fix them or file follow-up tasks

### 6. Check for similar patterns

After the fix, search the codebase for the same anti-pattern elsewhere:

- If a factory method was creating new instances per call, are there other factory methods doing the same?
- If fire-and-forget async init was the issue, are there other `promise.catch()` patterns without `await`?
- Fix any additional instances found, or file tasks if they're in different domains

## Key principles

- **The test is proof the bug exists.** Without it, you're guessing.
- **The test is proof the fix works.** Without it, you're hoping.
- **The test prevents regression.** Without it, the bug will return.
- **Minimal fix, maximal test.** Over-testing is fine. Over-fixing is not.

## Anti-patterns

- **Fixing without a test** — "I can see the bug in the code" is not a substitute for a failing test
- **Test that can't fail** — A test that passes with or without the fix proves nothing
- **Over-fixing** — Adding error handling, logging, or features beyond what the test requires
- **Skipping the full suite** — A fix that breaks other tests is not a fix
