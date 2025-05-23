# Task #001: Define Core Domain Interfaces for Testability

## Problem

The domain layer relies heavily on concrete implementations rather than interfaces, making it difficult to substitute test implementations and properly isolate components during testing. This leads to brittle tests that require modifying readonly properties and extensive mocking of unused methods.

## Implementation

1. Create a new file `src/domain/interfaces.ts` to define core interfaces for domain services:

   - Define `SessionProvider` interface for SessionDB operations
   - Define `GitServiceInterface` for GitService operations
   - Define `TaskServiceInterface` for TaskService operations
   - Define `WorkspaceUtilsInterface` for workspace utility functions

2. For each interface, extract only the methods that are used by other components, making mocking in tests more manageable.

3. Include documentation comments on each interface explaining their purpose and testing considerations.

4. For each interface, provide a function to create the default implementation:
   ```typescript
   export function createDefaultSessionProvider(): SessionProvider {
     return new SessionDB();
   }
   ```

## Expected Outcome

- Well-defined interfaces that represent the core domain components
- Cleaner separation between interfaces and implementations
- Foundation for further dependency injection improvements
- Reduction in type casting and `as any` usage in tests

## Dependencies

None - this is a foundational task.

## Benefits

- Immediate improvement in testability
- Enables future refactoring with proper interface-based dependency injection
- Provides clear documentation of the domain services' responsibilities
