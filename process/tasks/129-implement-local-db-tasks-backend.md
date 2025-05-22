# Task #129: Implement Local DB Tasks Backend

## Context

The current Minsky CLI uses a file-based approach (`tasks.md`) as its default task management backend, with a placeholder for a GitHub backend. This approach creates synchronization challenges when working across multiple sessions or workspaces. Specifically:

1. When a user edits the `tasks.md` file in a session, those changes are not reflected in other sessions or in the main workspace
2. This can lead to out-of-date task information when working in different contexts
3. Sometimes conflicting task IDs can occur due to this lack of synchronization

We need a more robust backend similar to the SessionDB, which already uses a local JSON file stored in a centralized location.

## Requirements

1. **Local JSON DB Backend Implementation**

   - Implement a `JsonFileTaskBackend` class that implements the `TaskBackend` interface
   - Leverage the `DatabaseStorage` abstraction created in Task #091
   - Store tasks in a centralized JSON file using the XDG directory standard (similar to SessionDB)
   - Support all operations defined in the `TaskBackend` interface

2. **Reuse of Database Abstraction Components**

   - Use the `DatabaseStorage<T, S>` interface from Task #091
   - Leverage the generic database utilities extracted in Task #091
   - Apply the same state management patterns used by SessionDB's implementation
   - Follow the functional core/imperative shell design like the SessionDB

3. **Migration Utility**

   - Implement a migration tool to convert existing `tasks.md` data to the new JSON file format
   - Support seamless transition between backends with no data loss
   - Provide verification and rollback capabilities during migration

4. **CLI Integration**

   - Update TaskService to include the new JsonFileTaskBackend
   - Add the backend option to all task-related CLI commands
   - Make JsonFileTaskBackend the default backend for new Minsky projects

5. **Synchronization Support**

   - Ensure changes made in any workspace or session are visible everywhere
   - Implement proper error handling for concurrent modifications
   - Consider adding timestamps to track when tasks were last modified

6. **Testing & Documentation**
   - Add comprehensive tests for the new backend
   - Update documentation to explain the new backend and its benefits
   - Document the migration process for existing projects

## Implementation Options

Several approaches could be considered for implementation:

### Option 1: Direct Database Abstraction Reuse

Directly reuse the `DatabaseStorage` interface and related utilities from Task #091, creating a JsonFileTaskBackend that implements the TaskBackend interface.

### Option 2: Domain-Driven Refactoring

Use the database abstraction from Task #091 while refining the domain models specific to tasks, ensuring proper separation between storage and domain logic.

### Option 3: Task Service Refactoring

Rebuild the TaskService with the storage abstraction from Task #091, allowing multiple persistence mechanisms without tight coupling.

## Implementation Steps

1. [ ] Analyze the database abstraction from Task #091

   - [ ] Review the `DatabaseStorage<T, S>` interface and reusable components
   - [ ] Identify how to apply these patterns to task management
   - [ ] Plan integration between TaskBackend interface and DatabaseStorage

2. [ ] Design the JsonFileTaskBackend class and storage schema

   - [ ] Define the JSON storage schema for tasks
   - [ ] Create adapter between TaskBackend interface and DatabaseStorage
   - [ ] Design a migration path from markdown to JSON format

3. [ ] Implement core functionality for reading/writing tasks

   - [ ] Create pure functions for task data manipulation
   - [ ] Reuse the I/O operations from the database abstraction
   - [ ] Add proper error handling for file system operations

4. [ ] Update TaskService to use the new backend

   - [ ] Add JsonFileTaskBackend to the available backends list
   - [ ] Implement factory methods to create the appropriate backend
   - [ ] Add configuration options for backend selection

5. [ ] Add migration utility for transitioning from tasks.md

   - [ ] Create a migration command in the Minsky CLI
   - [ ] Implement data validation during migration
   - [ ] Add rollback capabilities for failed migrations

6. [ ] Update CLI commands to support the new backend

   - [ ] Add backend selection options to all task commands
   - [ ] Update command documentation to describe the new options
   - [ ] Add backend auto-detection based on project configuration

7. [ ] Add comprehensive tests

   - [ ] Write unit tests for the pure functions
   - [ ] Create integration tests for the I/O operations
   - [ ] Add migration tests to verify data integrity

8. [ ] Update documentation
   - [ ] Document the new backend in the project README
   - [ ] Create a migration guide for existing projects
   - [ ] Update CLI command documentation

## Verification

- [ ] Tasks can be created, read, updated, and deleted using the new backend
- [ ] Task changes in one session are visible in other sessions and the main workspace
- [ ] Migration tool successfully converts existing tasks.md data
- [ ] All TaskBackend interface methods are properly implemented
- [ ] Documentation clearly explains the new backend and migration process
- [ ] All tests pass
