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

1. [ ] Update TaskBackend interface to include createTask method
2. [ ] Implement createTask in MarkdownTaskBackend:
   - [ ] Parse the spec file to extract title and description
   - [ ] Find the next available task ID
   - [ ] Create a task entry in tasks.md
   - [ ] Return the created Task object
3. [ ] Add createTask method to TaskService
4. [ ] Create a new file in src/commands/tasks/create.ts:
   - [ ] Define command using Commander.js
   - [ ] Add appropriate options and arguments
   - [ ] Implement action handler to call domain method
   - [ ] Add proper error handling
5. [ ] Register command in src/commands/tasks/index.ts
6. [ ] Add tests for the new functionality
7. [ ] Update documentation

## Verification

- [ ] Running `minsky tasks create path/to/spec.md` successfully creates a task
- [ ] The task is added to process/tasks.md with correct formatting
- [ ] The command returns the created task details
- [ ] All options work as expected
- [ ] Error handling works correctly for invalid inputs
- [ ] Tests pass 
