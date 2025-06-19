# Implement Todoist Backend Integration

## Context

The Minsky CLI currently supports task management through a default markdown backend (`tasks.md`) and has a placeholder for a GitHub backend. A Google Tasks backend implementation is also in development. Adding support for Todoist would provide integration with Todoist's popular task management system, allowing users to interact with their Todoist projects and tasks directly from the Minsky CLI.

## Requirements

1. **Todoist Backend Implementation**

   - Implement a `TodoistBackend` class that implements the `TaskBackend` interface
   - Support OAuth2 authentication with Todoist API
   - Store authentication tokens securely in the Minsky configuration directory
   - Handle token refresh and expiration

2. **Task Management Operations**

   - Implement the following operations for Todoist:
     - `listTasks`: List tasks from Todoist projects
     - `getTask`: Get a specific task by ID
     - `getTaskStatus`: Get the status of a task
     - `setTaskStatus`: Update the status of a task (complete/incomplete)
     - `createTask`: Create a new task in Todoist
     - `getWorkspacePath`: Return the workspace path

3. **Mapping Between Systems**

   - Map Minsky task statuses (`TODO`, `IN-PROGRESS`, `IN-REVIEW`, `DONE`) to Todoist task states
   - Map task IDs between systems
   - Handle Todoist projects and labels
   - Support priority levels and due dates from Todoist

4. **CLI Integration**

   - Update the TaskService to include the Todoist backend
   - Add the backend option to CLI commands
   - Update command schemas to include the new backend option
   - Support project filtering and selection

5. **Error Handling**

   - Implement robust error handling for API communication issues
   - Handle authentication failures gracefully
   - Provide clear error messages for configuration problems
   - Handle rate limiting from Todoist API

6. **Documentation**
   - Document the setup process for Todoist integration
   - Add examples for using Todoist in the Minsky CLI
   - Update the README with information about the new backend

## Implementation Steps

1. [ ] Add Todoist API dependencies to the project

   - [ ] Add Todoist REST API client library
   - [ ] Add OAuth2 authentication libraries

2. [ ] Implement authentication flow

   - [ ] Create OAuth2 client setup for Todoist
   - [ ] Implement token storage and retrieval
   - [ ] Handle token refresh and expiration

3. [ ] Create `TodoistBackend` class

   - [ ] Implement `TaskBackend` interface methods
   - [ ] Add Todoist-specific functionality
   - [ ] Map between Todoist and Minsky data models
   - [ ] Handle Todoist projects and labels

4. [ ] Update `TaskService` to include Todoist backend

   - [ ] Add Todoist to available backends
   - [ ] Update backend selection logic

5. [ ] Update CLI commands and schemas

   - [ ] Add 'todoist' as a backend option
   - [ ] Update command validation
   - [ ] Add project filtering options

6. [ ] Write tests

   - [ ] Unit tests for Todoist backend
   - [ ] Integration tests for backend operations
   - [ ] Mock API responses for testing

7. [ ] Add documentation
   - [ ] Setup instructions for Todoist OAuth
   - [ ] Usage examples
   - [ ] README update

## Verification

- [ ] Todoist backend can be selected and used via CLI commands
- [ ] All TaskBackend methods work correctly with Todoist
- [ ] Authentication flow works properly
- [ ] Error handling is robust and user-friendly
- [ ] Project filtering and task organization works
- [ ] Documentation is clear and complete
- [ ] All tests pass

## Notes

- Follow the same patterns established by the Google Tasks backend implementation
- Consider Todoist's specific features like projects, labels, and priority levels
- Ensure proper handling of Todoist's rate limiting
- Support both personal and shared projects where appropriate
