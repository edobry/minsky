# Task #102: Refactor Domain Objects to Follow Functional Patterns

## Context

Our domain objects (SessionDB, GitService, TaskService) are designed with class-based, stateful architectures that make testing difficult. Many methods have side effects or rely on internal state. A more functional approach with pure functions and explicit dependencies would make the code more testable and maintainable.

## Requirements

1. **Pure Function Approach**
   - Convert key methods to pure, stateless functions
   - Make side effects explicit and pushed to the edges
   - Move away from class-based design to functional composition

2. **State Management**
   - Extract state management to dedicated stores/providers
   - Make state changes explicit and testable
   - Implement immutable patterns for state updates

3. **Side Effect Isolation**
   - Isolate I/O operations (file system, network, etc.)
   - Create wrappers for side effects that can be easily mocked
   - Use dependency injection for all external operations

## Implementation Steps

1. [ ] Refactor SessionDB:
   - [ ] Extract core operations to pure functions
   - [ ] Create a state provider for session data
   - [ ] Implement immutable update patterns

2. [ ] Refactor GitService:
   - [ ] Extract git operations to pure functions
   - [ ] Isolate shell command execution
   - [ ] Create testable wrappers for all git commands

3. [ ] Refactor TaskService:
   - [ ] Extract task operations to pure functions
   - [ ] Implement store pattern for task state
   - [ ] Separate backend implementations from core logic

4. [ ] Update domain function implementations:
   - [ ] Apply functional composition
   - [ ] Eliminate hidden dependencies
   - [ ] Ensure proper error handling with pure functions

5. [ ] Update tests to leverage functional approach:
   - [ ] Create test utilities for functional testing
   - [ ] Implement property-based testing where appropriate
   - [ ] Eliminate the need for complex mocking

## Verification

- [ ] All tests pass with simpler mocking requirements
- [ ] Functions can be tested in isolation without side effects
- [ ] Improved code reuse through functional composition
- [ ] Better error handling with explicit failure paths 
