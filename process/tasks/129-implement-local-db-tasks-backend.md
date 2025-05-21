# Task #129: Implement Local DB Tasks Backend

## Context

The current Minsky CLI uses a file-based approach (`tasks.md`) as its default task management backend, with a placeholder for a GitHub backend. This approach creates synchronization challenges when working across multiple sessions or workspaces. Specifically:

1. When a user edits the `tasks.md` file in a session, those changes are not reflected in other sessions or in the main workspace
2. This can lead to out-of-date task information when working in different contexts
3. Sometimes conflicting task IDs can occur due to this lack of synchronization

We need a more robust backend similar to the SessionDB, which already uses a local JSON file stored in a centralized location.

## Requirements

1. **Local DB Backend Implementation**

   - Implement a `LocalDbTaskBackend` class that implements the `TaskBackend` interface
   - Store tasks in a centralized JSON file using the XDG directory standard (similar to SessionDB)
   - Support all operations defined in the `TaskBackend` interface

2. **Code Reuse and Architecture**

   - Extract common database functionality from SessionDB into a reusable component if possible
   - Alternatively, follow similar patterns to SessionDB's implementation for consistency
   - Consider a functional core/imperative shell design like the current SessionDB

3. **Migration Utility**

   - Implement a migration tool to convert existing `tasks.md` data to the new local DB format
   - Support seamless transition between backends with no data loss
   - Provide verification and rollback capabilities during migration

4. **CLI Integration**

   - Update TaskService to include the new LocalDB backend
   - Add the backend option to all task-related CLI commands
   - Make local DB the default backend for new Minsky projects

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

### Option 1: Minimal Adapter Pattern

Create a LocalDbTaskBackend adapter that uses the same design pattern as the MarkdownTaskBackend but stores data in a centralized JSON file.

### Option 2: Domain-Driven Refactoring

Extract a more general "storage" concept from both SessionDB and TaskBackend, creating a foundational storage layer that can be reused across different domain objects.

### Option 3: Task Service Refactoring

Rebuild the TaskService with a focus on persistence abstraction, allowing multiple persistence mechanisms without tight coupling.

## Implementation Steps

1. [ ] Analyze SessionDB implementation to identify reusable patterns

   - [ ] Review the SessionDB code structure, particularly the functional patterns
   - [ ] Identify pure functions vs. I/O operations in the current implementation
   - [ ] Determine components that could be extracted for reuse

2. [ ] Design the LocalDbTaskBackend class and storage schema

   - [ ] Define the JSON storage schema for tasks
   - [ ] Create interfaces for the database operations
   - [ ] Design a migration path from markdown to JSON format

3. [ ] Implement core functionality for reading/writing tasks

   - [ ] Create pure functions for task data manipulation
   - [ ] Implement I/O operations for reading/writing the JSON database
   - [ ] Add proper error handling for file system operations

4. [ ] Update TaskService to use the new backend

   - [ ] Add LocalDbTaskBackend to the available backends list
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
