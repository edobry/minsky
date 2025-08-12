# Refactor TaskService to Functional Patterns (Subtask of #102)

## Context

This task is a subtask of #102 (Refactor Domain Objects to Follow Functional Patterns). It focuses on refactoring the `TaskService` and its associated backends (e.g., `MarkdownTaskBackend`) to align with functional programming principles. This aims to enhance testability, clarify state management, and isolate side effects related to task data persistence.

## Requirements

1.  **Pure Functions for `TaskService` Core Logic**:

    - Convert core task manipulation logic within `TaskService` and its backends into pure functions.
    - Operations like parsing task files, formatting task data, filtering tasks, and determining next IDs should be pure.
    - State (e.g., the content of `tasks.md` or other backend-specific data representations) should be passed explicitly to these functions, and they should return new state or derived data.

2.  **Explicit State and Backend Interaction**:

    - Pure functions should operate on explicit representations of task data (e.g., an array of task objects, or a string representing the raw content of `tasks.md`).
    - Functions that modify task data should return a new representation of that data.

3.  **Isolation of Side Effects (File I/O, Backend API Calls)**:

    - All side effects, such as reading/writing `tasks.md` (for `MarkdownTaskBackend`) or making API calls (for potential future backends like GitHub issues), must be strictly isolated from the pure task logic functions.
    - This will involve dedicated I/O or API interaction modules/services that the pure functions can instruct.

4.  **Backend Abstraction Maintained**:

    - The existing `TaskBackend` interface should be adapted or redesigned to work with the functional approach. Pure data transformation functions might be part of the backend implementation, while the side-effectful operations are handled by a separate layer invoked by the `TaskService`.

5.  **Functional Composition**:

    - Use functional composition techniques for complex task operations (e.g., applying multiple filters, transforming data through several stages).

6.  **Update Tests**:
    - Rewrite unit tests to target the pure functions, verifying their transformations and logic based on inputs.
    - Integration tests will need to mock the I/O or backend API layers to test the full lifecycle of task operations (e.g., creating a task and verifying it's written correctly by the side-effect handler).

## Implementation Steps

1.  [ ] Analyze `TaskService` and `MarkdownTaskBackend` (and any other backends) to identify core logic, state, and side effects.
2.  [ ] Define clear data structures for representing task lists and individual task states, suitable for passing to pure functions.
3.  [ ] Implement pure functions for task operations:
    - Example: `parseTasksFromString(fileContent: string): Task[]`
    - Example: `addTaskToState(currentState: Task[], newTaskData): Task[]`
    - Example: `filterTasks(tasks: Task[], criteria): Task[]`
    - Example: `formatTasksToString(tasks: Task[]): string`
4.  [ ] Create or adapt I/O/Backend interaction modules:
    - Example for Markdown: `readTasksFile(): Promise<string>`, `writeTasksFile(content: string): Promise<void>`
5.  [ ] Refactor `TaskService` to orchestrate calls to pure functions and the side-effect handlers.
6.  [ ] Adapt the `TaskBackend` interface and implementations accordingly.
7.  [ ] Update all relevant unit and integration tests.
8.  [ ] Document the new architecture for `TaskService`.

## Verification

- [ ] Core `TaskService` logic is implemented as pure functions.
- [ ] Side effects (file I/O, backend interactions) are clearly separated.
- [ ] All tests pass or are updated; new tests provide sufficient coverage.
- [ ] Task management features of the application remain functional.
- [ ] Code adheres to project standards.

Parent Task: #102

# Additional Notes
