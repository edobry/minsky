# Task #002: Implement Consistent Dependency Injection Pattern

## Problem

Current domain functions have inconsistent dependency injection patterns, with some functions accepting dependencies and others directly importing them. This makes testing difficult, particularly when mocking dependencies that are imported directly rather than injected.

## Implementation

1. Refactor core domain functions to accept dependencies as parameters, focusing on the most commonly used functions first:
   - `resolveRepoPath`
   - `getCurrentSession`
   - `approveSessionFromParams`
   - `startSessionFromParams`
   - `listSessionsFromParams`

2. For each function, implement a consistent pattern:
   ```typescript
   export function someFunction(
     params: Params,
     deps: {
       service1: Service1Interface;
       service2: Service2Interface;
     } = defaultDeps
   ): Result {
     // Implementation
   }
   
   const defaultDeps = {
     service1: createDefaultService1(),
     service2: createDefaultService2()
   };
   ```

3. Make all dependency parameters optional with sensible defaults.

4. Update function implementations to use the injected dependencies.

5. Update existing tests to use the new dependency injection pattern.

## Expected Outcome

- Consistent dependency injection pattern across domain functions
- Improved testability without modifying readonly properties
- Clear separation between function parameters and dependencies
- More flexible testing approach that doesn't rely on module mocking

## Dependencies

- Task #001: Define Core Domain Interfaces for Testability

## Benefits

- Makes tests more reliable and easier to maintain
- Enables precise control over dependencies in tests
- Reduces the need for complex module mocking
- Improves code documentation by making dependencies explicit 
