# Task #032: Auto-Rename Task Spec Files in `tasks create` Command

## Context

Currently, when using the `minsky tasks create` command, the task ID is assigned by the system but the spec file is not automatically renamed to match this ID. This requires manual intervention to rename the file after creation, which can lead to inconsistencies and errors if forgotten. The command should handle this automatically to ensure consistency and improve user experience.

## Requirements

1. **Automatic File Renaming**

   - After assigning a task ID, automatically rename the spec file to match the standardized format
   - Format: `process/tasks/{id}-{kebab-case-title}.md`
   - Handle cases where the target filename already exists
   - Update the task's specPath to reflect the new location

2. **Error Handling**

   - Handle file system errors gracefully (permissions, file exists, etc.)
   - Provide clear error messages if renaming fails
   - Roll back task creation if file operations fail
   - Handle edge cases like read-only files or directories

3. **Path Resolution**

   - Support both absolute and relative paths for input spec file
   - Ensure the renamed file is always in the correct `process/tasks` directory
   - Handle cases where the source file is already in the tasks directory

4. **User Experience**
   - Log a message indicating the file was renamed
   - Include both old and new paths in the output
   - Support a `--dry-run` option to show what would happen without making changes

## Implementation Steps

1. [ ] Update `createTask` method in `MarkdownTaskBackend`:

   - [ ] Add function to generate standardized filename from task ID and title
   - [ ] Add file renaming logic after task ID assignment
   - [ ] Update task entry in tasks.md with new path
   - [ ] Add rollback functionality for error cases

2. [ ] Add new options to `tasks create` command:

   - [ ] Add `--dry-run` flag to preview changes
   - [ ] Add `--force` flag to overwrite existing files
   - [ ] Update command help text

3. [ ] Add tests:

   - [ ] Test successful file renaming
   - [ ] Test error cases and rollback
   - [ ] Test path resolution edge cases
   - [ ] Test dry run functionality

4. [ ] Update documentation:
   - [ ] Update command help text
   - [ ] Update README with new behavior
   - [ ] Update changelog

## Example Output

```bash
$ minsky tasks create temp-spec.md
Task #042 created: Add New Feature
Renamed spec file:
  From: temp-spec.md
  To: process/tasks/042-add-new-feature.md

$ minsky tasks create temp-spec.md --dry-run
Would create task #043: Add New Feature
Would rename spec file:
  From: temp-spec.md
  To: process/tasks/043-add-new-feature.md
```

## Verification

- [ ] Running `minsky tasks create temp-spec.md` successfully:
  - Creates the task
  - Renames the spec file to match the assigned ID
  - Updates tasks.md with the correct path
- [ ] The `--dry-run` option shows what would happen without making changes
- [ ] Error handling works correctly for all edge cases
- [ ] All tests pass
- [ ] Documentation is updated to reflect the new behavior
- [ ] Changelog is updated with a reference to this task spec
