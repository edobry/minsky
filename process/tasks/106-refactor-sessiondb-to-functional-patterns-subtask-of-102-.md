# Task #106: Refactor SessionDB to Functional Patterns (Subtask of #102)

## Context

This task is a subtask of #102 (Refactor Domain Objects to Follow Functional Patterns). It focuses on refactoring the `SessionDB` module to align with functional programming principles. This is part of a larger effort to improve code testability, maintainability, and predictability within the domain layer.

## Requirements

1.  **Pure Functions for `SessionDB` Operations**:

    - Convert all methods in `SessionDB` (e.g., `listSessions`, `getSession`, `addSession`, `updateSession`, `deleteSession`, `getRepoPath`, `getSessionWorkdir`) into pure functions.
    - These functions should not have side effects (e.g., no direct file I/O or modification of external state).
    - State (such as the content of `session-db.json`) must be passed explicitly as an argument to these functions.
    - Functions that modify state should return a new state representation instead of mutating the input state.

2.  **Explicit State Management**:

    - The in-memory representation of the session database (currently handled within `SessionDB` class instances) should be managed explicitly.
    - Functions will take the current DB state as input and return the updated DB state as output.

3.  **Isolation of Side Effects**:

    - All file system operations (reading from and writing to `session-db.json`) must be isolated from the core pure functions.
    - These side effects should be handled at the application's boundaries or through a dedicated, controlled interface (e.g., a new service or a set of specific I/O functions) that the pure functions can instruct.

4.  **Functional Composition**:

    - Where appropriate, use functional composition techniques to build more complex operations from simpler, pure functions. This might involve creating smaller helper functions.

5.  **Update Tests**:

    - Thoroughly update or rewrite all existing unit and integration tests for `SessionDB`.
    - Tests for pure functions should focus on input-output validation without needing to mock extensive dependencies.
    - Tests for the parts of the system that handle side effects will require appropriate mocking of the I/O operations.

6.  **Maintain Compatibility (where feasible)**:
    - While refactoring, consider the existing dependents of `SessionDB` and strive to minimize disruptive changes to their interfaces, if possible. If significant interface changes are necessary, they should be documented.

## Implementation Steps

1.  [ ] Analyze current `SessionDB` methods and identify all side effects and state manipulations.
2.  [ ] Define clear data structures for representing the session database state.
3.  [ ] Implement pure function versions for each `SessionDB` operation:
    - [ ] `listSessionsFn(dbState)`
    - [ ] `getSessionFn(dbState, sessionName)`
    - [ ] `getSessionByTaskIdFn(dbState, taskId)`
    - [ ] `addSessionFn(dbState, newSessionRecord)`
    - [ ] `updateSessionFn(dbState, sessionName, updates)`
    - [ ] `deleteSessionFn(dbState, sessionName)`
    - [ ] `getRepoPathFn(dbState, sessionRecord)` (or adapt if state dependency changes)
    - [ ] `getSessionWorkdirFn(dbState, sessionName)` (or adapt)
4.  [ ] Create a separate module or service for handling the actual file I/O (reading and writing `session-db.json`).
    - [ ] `readSessionDbFile(): Promise<SessionDbState>`
    - [ ] `writeSessionDbFile(dbState: SessionDbState): Promise<void>`
5.  [ ] Refactor existing code that uses `SessionDB` to work with the new pure functions and the I/O service. This will likely involve changes in how services are instantiated or how data flows.
6.  [ ] Update all unit tests for `SessionDB` logic to test the pure functions directly.
7.  [ ] Update/create integration tests to cover the interaction between the pure functions and the side-effect-handling module.
8.  [ ] Document any significant changes to the `SessionDB` interface and usage patterns.

## Verification

- [ ] All `SessionDB` core logic is implemented as pure functions.
- [ ] Side effects (file I/O) are clearly separated from pure logic.
- [ ] All existing tests for `SessionDB` pass or have been updated.
- [ ] New tests provide adequate coverage for the refactored code.
- [ ] The application remains functional with the refactored `SessionDB`.
- [ ] Code conforms to project linting and style guidelines.

Parent Task: #102
