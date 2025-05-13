# Task #062: Improve bun:test TypeScript Declarations

## Context
We've observed discrepancies between bun:test runtime behavior and its TypeScript definitions, leading to linter errors for valid code (e.g., `test.skip`, `test.todo`, `mock.fn`). Improving these declarations will enhance the developer experience and reduce confusion.

## Requirements
- Create or update TypeScript declaration files (`.d.ts`) to provide correct types for bun:test APIs.
- Specifically address known issues with `test.skip`, `test.todo`, `mock()`, and `mock.fn()`, ensuring mock instance methods (`mockClear`, `mockReturnValue`, etc.) are correctly typed.
- Consider submitting improvements as pull requests to relevant type repositories if applicable.

## Implementation Steps
- [ ] Investigate existing bun:test type definitions.
- [ ] Identify specific areas where types are incomplete or incorrect.
- [ ] Create a local `bun-test.d.ts` file (e.g., in `types/`).
- [ ] Add correct declarations for `test.skip` and `test.todo`.
- [ ] Add correct declarations for `mock()` and `mock.fn()`.
- [ ] Ensure mock instance methods are correctly typed.
- [ ] Configure `tsconfig.json` if necessary to include the new declaration file.
- [ ] Verify that the previously observed linter errors are resolved by the new types.
- [ ] Consider contributing changes upstream if feasible.
- [ ] Update documentation.

## Verification
- [ ] Running `bun lint` no longer shows errors for valid bun:test API usage (like `test.skip`, `test.todo`).
- [ ] TypeScript correctly infers types for mock objects and their methods.
- [ ] The project compiles without type errors related to bun:test APIs. 
