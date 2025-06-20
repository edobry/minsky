# Task #007: Add `minsky tasks create` Command

## Context

The Minsky CLI currently lacks a streamlined way to create new tasks from specification documents. Users need to manually update the tasks.md file and ensure proper linking. An automated command would improve workflow efficiency and reduce errors.

## Requirements

1. **CLI Behavior**

   - Command signature:
     ```
     minsky tasks create <spec-path>
     ```
   - The command should:
     - Parse the provided task specification document
     - Extract the title and description
     - Assign the next available ID
     - Add a checklist item to process/tasks.md
     - Return the created task details

2. **Integration with Domain Module**

   - Use the TaskService domain module to record the task
   - Add a createTask method to the TaskService class
   - Implement createTask in the MarkdownTaskBackend

3. **Error Handling**

   - Validate that the spec file exists
   - Ensure the spec file has a valid title and description
   - Handle errors gracefully with informative messages

4. **CLI Options**
   - Support the following options:
     - `--session <session>`: Session name to use for repo resolution
     - `--repo <repoPath>`: Path to a git repository (overrides session)
     - `--backend <backend>`: Specify task backend (markdown, github)
     - `--json`: Output task as JSON

## Implementation Steps

1. [x] Update TaskBackend interface to include createTask method
2. [x] Implement createTask in MarkdownTaskBackend:
   - [x] Parse the spec file to extract title and description
   - [x] Find the next available task ID
   - [x] Create a task entry in tasks.md
   - [x] Return the created Task object
3. [x] Add createTask method to TaskService
4. [x] Create a new file in src/commands/tasks/create.ts:
   - [x] Define command using Commander.js
   - [x] Add appropriate options and arguments
   - [x] Implement action handler to call domain method
   - [x] Add proper error handling
5. [x] Register command in src/commands/tasks/index.ts
6. [x] Add tests for the new functionality
7. [x] Update documentation

## Verification

- [x] Running `minsky tasks create path/to/spec.md` successfully creates a task
- [x] The task is added to process/tasks.md with correct formatting
- [x] The command returns the created task details
- [x] All options work as expected
- [x] Error handling works correctly for invalid inputs
- [x] Tests pass

## Work Log

- 2023-05-03: Created a session for task #007
- 2023-05-03: Updated TaskBackend interface to include createTask method
- 2023-05-03: Implemented createTask in MarkdownTaskBackend
- 2023-05-03: Added createTask method to TaskService
- 2023-05-03: Created src/commands/tasks/create.ts with Commander.js command
- 2023-05-03: Registered command in src/commands/tasks/index.ts
- 2023-05-03: Added tests for the createTask functionality
- 2023-05-03: Updated CHANGELOG.md
- 2023-05-03: Updated task specification with implementation details
