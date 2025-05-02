# Task #023: Add Task Specification Path to Task Object

## Context

Currently, the task object in Minsky includes properties like ID, title, status, and description. However, it does not include the path to the task specification document. This makes it difficult for users to quickly locate and open the detailed task specification file when viewing task details, especially when working on task implementation.

Adding the specification path to the task object would improve the workflow by providing direct access to the full task specification document from any command that returns task details.

## Requirements

1. **Update Task Object Structure**
   - Add a `specPath` property to the Task interface in `src/domain/tasks.ts`
   - Ensure this property holds the absolute or relative path to the task specification document
   - Make the property optional to maintain backward compatibility with existing tasks

2. **Task Backend Updates**
   - Update the MarkdownTaskBackend to populate the `specPath` property when parsing tasks
   - The path should be derived from the task ID and follow the established convention (e.g., `process/tasks/023-task-name.md`)
   - Handle edge cases where task spec files might be in different locations or might not exist

3. **Command Output Updates**
   - Update the `tasks get` command to display the specification path in its output
   - Ensure the `--json` output includes the new `specPath` property
   - Consider adding a flag to open the spec file directly (e.g., `--open` or `--edit`)

4. **Documentation Updates**
   - Update relevant documentation to mention the new property
   - Provide examples of how to use the property in workflows

## Implementation Steps

1. **Update Domain Models**
   - Modify the Task interface in `src/domain/tasks.ts` to include the optional `specPath` property
   - Update any relevant type definitions or interfaces that extend or use the Task type

2. **Update Task Backend**
   - Modify the MarkdownTaskBackend to populate the `specPath` property when parsing tasks
   - Implement logic to determine the correct path based on task ID and conventions
   - Add tests to verify the path is correctly generated

3. **Update Commands**
   - Modify the `tasks get` command to display the spec path in its output
   - Ensure the `--json` output includes the new property
   - Update any other commands that return full task details

4. **Testing**
   - Add unit tests for the updated domain model and backend
   - Add integration tests for the command output
   - Test edge cases (e.g., tasks without spec files)

## Verification

- [x] The Task interface includes the new `specPath` property
- [x] The MarkdownTaskBackend correctly populates the `specPath` property
- [x] The `tasks get` command displays the spec path in its output
- [x] The `--json` output includes the new property
- [x] All tests pass
- [x] Documentation is updated

## Work Log

- 2025-05-01: Implemented specPath property in Task interface, updated MarkdownTaskBackend to populate it, and updated tasks get command to display it

## Notes

- This enhancement will improve the developer experience by making it easier to navigate between task summaries and detailed specifications
- Future enhancements could include a command to open the specification file directly in an editor 
