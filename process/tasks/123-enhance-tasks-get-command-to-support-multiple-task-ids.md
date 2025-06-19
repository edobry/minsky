# Enhance `tasks get` Command to Support Multiple Task IDs

## Context

The current `minsky tasks get` command only supports retrieving information for a single task at a time. This limitation makes it difficult for users to understand one task in the context of several others, requiring them to run multiple commands and manually correlate the information.

## Goal

Enhance the `tasks get` command to support fetching information about multiple tasks in a single command invocation. This will allow users to quickly gather context about related tasks and understand their interdependencies.

## Requirements

1. **Command Interface**

   - Modify the `minsky tasks get` command to accept multiple task IDs
   - Support both comma-separated format and multiple arguments:
     ```bash
     # These should be equivalent:
     minsky tasks get 001,002,003
     minsky tasks get 001 002 003
     ```
   - Maintain backward compatibility with the current single-task behavior

2. **Task Schema Updates**

   - Update the task schema to support arrays of task IDs
   - Modify the task get parameters to handle multiple tasks

3. **CLI and MCP Adapters**

   - Update the CLI adapter to parse multiple task arguments
   - Update the MCP adapter to support multiple task requests
   - In both adapters, ensure appropriate error handling for mixed valid/invalid IDs

4. **Domain Logic**

   - Extend the task service to efficiently fetch multiple tasks
   - When a task ID doesn't exist, continue processing other valid IDs and include error information in the response

5. **Output Format**

   - When returning multiple tasks in non-JSON format, clearly separate each task with headers
   - For JSON output, return an array of task objects
   - Include information about any task IDs that could not be found

6. **Error Handling**
   - If all specified task IDs are invalid, return an appropriate error
   - If some IDs are valid and others are invalid, return the valid tasks with a warning about the invalid IDs
   - Maintain consistent error messages with the existing command

## Success Criteria

- Users can fetch information about multiple tasks with a single command
- The output is clear, consistent, and well-formatted for both terminal and JSON consumers
- Error handling is robust, providing useful feedback about both valid and invalid task IDs
- The implementation follows the interface-agnostic command architecture principles
- All existing tests continue to pass, and new tests are added for the multi-task functionality
