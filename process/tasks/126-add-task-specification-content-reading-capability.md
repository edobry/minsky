# Add Task Specification Content Reading Capability

## Context

Currently, the Minsky CLI provides ways to get task metadata (ID, title, status, etc.) through the `tasks get` command, but there's no direct way to read the full content of a task's specification file. Users need to manually locate and open the spec file to view its full content.

Adding a capability to read and display task specification content would improve the workflow by providing direct access to the full task details from the command line, making it easier to review task requirements and implementation plans.

## Requirements

1. **Add Task Spec Content Reading Capability**

   - Add the ability to read and display the full content of a task's specification file
   - Support both a flag for the existing `tasks get` command AND/OR a separate command for dedicated spec reading
   - Display the content in a readable format, preserving Markdown formatting when possible

2. **CLI Implementation Options**

   Option A: Add a flag to the existing `tasks get` command:

   ```
   minsky tasks get <task-id> --show-spec
   ```

   Option B: Create a new dedicated subcommand:

   ```
   minsky tasks spec <task-id>
   ```

   Determine which approach is more consistent with the existing CLI design patterns.

3. **Domain and Backend Updates**

   - Update the domain layer to support reading task specification file content
   - Utilize existing `readTaskSpecFile` or similar functionality
   - Ensure error handling for missing spec files

4. **Output Formatting**

   - Format the output to be readable in terminal
   - Support JSON output for programmatic consumption
   - Consider adding options for extracting specific sections (e.g., `--section requirements`)

5. **Documentation Updates**
   - Update relevant documentation to include the new command or flag
   - Add examples showing how to use the functionality

## Implementation Steps

1. [ ] Analyze existing codebase:

   - [ ] Determine if this should be a flag on `tasks get` or a separate command
   - [ ] Review existing task spec file reading functionality
   - [ ] Identify domain methods needed for implementation

2. [ ] Domain Layer Updates:

   - [ ] Add method to fetch task spec content in TaskService
   - [ ] Ensure proper error handling for missing files

3. [ ] CLI Implementation:

   - [ ] Implement chosen approach (flag or separate command)
   - [ ] Add proper command documentation
   - [ ] Add output formatting options

4. [ ] Testing:

   - [ ] Add unit tests for the new functionality
   - [ ] Add integration tests to verify CLI behavior

5. [ ] Documentation:
   - [ ] Update README or CLI help text
   - [ ] Add examples to documentation

## Verification

- [ ] Running the command/flag successfully displays the content of a task specification file
- [ ] Error handling works correctly for invalid tasks or missing spec files
- [ ] Output is properly formatted and readable
- [ ] JSON output option works correctly (if implemented)
- [ ] All tests pass
- [ ] Documentation is updated with examples
