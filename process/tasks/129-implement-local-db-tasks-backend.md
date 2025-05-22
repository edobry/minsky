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

1. [ ] Create the Database Abstraction Layer
   - [ ] Design and implement the `DatabaseStorage<T, S>` interface with generic types
     - [ ] Define CRUD operations: read, write, update, delete
     - [ ] Include error handling patterns and result types
     - [ ] Support state management and transaction concepts
   - [ ] Implement a `JsonFileStorage<T>` class that implements the interface
     - [ ] Create file system utility functions for read/write operations
     - [ ] Implement proper error handling and recovery mechanisms
     - [ ] Add support for data validation and schema enforcement
   - [ ] Extract common utilities (path resolution, XDG directory handling, etc.)

2. [ ] Implement the JsonFileTaskBackend
   - [ ] Define the task state schema for JSON storage
     - [ ] Include task data structure with all required fields
     - [ ] Add metadata including last modified timestamps
     - [ ] Design for backward compatibility with existing task data
   - [ ] Create the `JsonFileTaskBackend` class implementing `TaskBackend`
     - [ ] Implement adapter methods between TaskBackend and DatabaseStorage
     - [ ] Ensure all TaskBackend interface methods are properly implemented
     - [ ] Use functional core/imperative shell design pattern
   - [ ] Implement pure functions for task data manipulation
     - [ ] Separate data manipulation logic from I/O operations
     - [ ] Create functions for task filtering, sorting, and transformation
     - [ ] Ensure all operations are side-effect free

3. [ ] Create Migration Utility
   - [ ] Implement a parser for existing tasks.md format
     - [ ] Support all current task data formats and variations
     - [ ] Handle edge cases and incomplete task data
   - [ ] Build migration functionality
     - [ ] Create a dry-run option for validation without changes
     - [ ] Implement backup creation before migration
     - [ ] Add verification steps to ensure data integrity
   - [ ] Add rollback capability
     - [ ] Store backup of original data during migration
     - [ ] Implement restore functionality for failed migrations
     - [ ] Add detailed error reporting during migration

4. [ ] Update TaskService for Multiple Backends
   - [ ] Modify TaskService to support the new backend
     - [ ] Update backend registration and selection mechanism
     - [ ] Ensure backward compatibility with existing code
     - [ ] Add factory methods for creating appropriate backends
   - [ ] Add configuration options for backend selection
     - [ ] Support environment variables for backend selection
     - [ ] Add project configuration for default backend
     - [ ] Implement automatic backend detection

5. [ ] Update CLI Integration
   - [ ] Add CLI options for backend selection
     - [ ] Add `--backend` option to all task commands
     - [ ] Support environment variables for default backend
   - [ ] Implement migration command
     - [ ] Create `tasks migrate` command with options
     - [ ] Add validation and safety checks
     - [ ] Implement progress reporting
   - [ ] Update documentation and help text
     - [ ] Document new backend options in CLI help
     - [ ] Add examples for backend selection and migration

6. [ ] Implement Synchronization Support
   - [ ] Add timestamps to track modifications
     - [ ] Store creation and modification timestamps
     - [ ] Implement timestamp-based conflict detection
   - [ ] Handle concurrent modifications
     - [ ] Implement optimistic locking with version numbers
     - [ ] Add conflict detection and resolution strategies
     - [ ] Ensure atomic write operations when possible

7. [ ] Add Comprehensive Tests
   - [ ] Write unit tests for the database abstraction
     - [ ] Test all CRUD operations
     - [ ] Test error handling and recovery
     - [ ] Test data validation
   - [ ] Create integration tests for the JsonFileTaskBackend
     - [ ] Test all TaskBackend interface methods
     - [ ] Test migration functionality
     - [ ] Test concurrent access scenarios
   - [ ] Add migration tests
     - [ ] Test migration from different task.md formats
     - [ ] Test rollback functionality
     - [ ] Test data integrity after migration

8. [ ] Update Documentation
   - [ ] Document the database abstraction
     - [ ] Describe the interface and its generic types
     - [ ] Explain the design patterns used
     - [ ] Provide examples of implementation
   - [ ] Create documentation for the JsonFileTaskBackend
     - [ ] Explain benefits over the Markdown backend
     - [ ] Document configuration options
     - [ ] Provide usage examples
   - [ ] Write migration guide
     - [ ] Step-by-step instructions for migration
     - [ ] Troubleshooting common issues
     - [ ] Explain rollback process if needed

## Verification

- [ ] Tasks can be created, read, updated, and deleted using the new backend
- [ ] Task changes in one session are visible in other sessions and the main workspace
- [ ] Migration tool successfully converts existing tasks.md data
- [ ] All TaskBackend interface methods are properly implemented
- [ ] Documentation clearly explains the new backend and migration process
- [ ] All tests pass with adequate coverage

## Task Analysis Notes

After examining the codebase, I found that the `DatabaseStorage` interface referenced in Task #091 has not yet been implemented. Therefore, this task will involve:

1. Designing and implementing the core `DatabaseStorage<T, S>` interface
2. Creating a `JsonFileStorage<T>` implementation 
3. Building the `JsonFileTaskBackend` on top of this storage layer

The implementation will follow the functional core/imperative shell pattern seen in the SessionDB, with a clear separation between:
- Pure functions for data manipulation
- I/O operations for persistence
- Adapter layer to connect the two

We'll leverage the XDG directory standard for centralized storage, similar to how SessionDB works, ensuring task data is consistent across workspaces and sessions.
