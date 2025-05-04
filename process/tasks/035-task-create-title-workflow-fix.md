# Task #035: Fix Task Creation Workflow to Not Require Task Number in Spec Title

## Context

Currently, the Minsky CLI requires users to specify the task number in the spec file title (e.g., `# Task #034: Title`) when creating a new task. This is not user-friendly and contradicts the intended workflow, where the CLI should assign the next available task number automatically. The correct process should allow users to write a temp spec file with a title like `# Task: Title`, and the CLI should handle number assignment, title update, and file renaming.

## Requirements

1. **Flexible Title Parsing**
   - Allow the task spec file to use the title format `# Task: Title` (without a number).
   - Continue to support `# Task #XXX: Title` for backward compatibility.

2. **Automatic Number Assignment**
   - When registering a new task, the CLI should:
     - Parse the title from `# Task: Title`
     - Assign the next available task number
     - Update the title in the file to `# Task #XXX: Title`
     - Rename the file to match the assigned number and title (e.g., `034-title.md`)
     - Update the checklist entry in `process/tasks.md`

3. **User Experience**
   - Provide clear output to the user about the assigned task number, updated file name, and checklist entry.
   - Handle errors gracefully if the title is missing or malformed.

4. **Testing and Validation**
   - Add tests to cover both `# Task: Title` and `# Task #XXX: Title` formats.
   - Test that the file is updated and renamed correctly.
   - Test error cases (missing title, duplicate file, etc.).

5. **Documentation**
   - Update documentation and examples to reflect the improved workflow.

## Implementation Steps

1. [ ] Update the task creation logic to accept `# Task: Title` and assign the number automatically.
2. [ ] Implement logic to update the title in the file and rename the file after number assignment.
3. [ ] Update CLI output to inform the user of changes.
4. [ ] Add/modify tests for both title formats and error cases.
5. [ ] Update documentation and changelog.

## Verification

- [ ] Users can create a task with a spec file titled `# Task: Title` and the CLI assigns the number, updates the file, and renames it.
- [ ] Backward compatibility is maintained for `# Task #XXX: Title`.
- [ ] All tests pass for both formats and error cases.
- [ ] Documentation is updated to reflect the new workflow. 
