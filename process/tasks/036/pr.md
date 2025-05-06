# Improve Task Creation Workflow with Auto-Renaming and Flexible Titles

## Summary

This PR improves the task creation workflow in two main ways:

1. Adds support for a more flexible title format in task spec files: `# Task: Title` (without requiring a task number)
2. Automatically renames the spec file after creating the task to match the standardized format

## Details

### Flexible Title Support

- Modified `MarkdownTaskBackend.createTask` to parse both `# Task: Title` and `# Task #XXX: Title` formats
- When a task number is not provided in the title, the next available ID is assigned
- The title in the file is updated to include the assigned task ID

### Automatic File Renaming

- After assigning a task ID, the spec file is automatically renamed to the standardized format: `process/tasks/{id}-{kebab-case-title}.md`
- The task's specPath in both the task object and tasks.md is updated to reflect the new location
- The original file is removed after successful creation

### Added Options

- `--dry-run`: Shows what would happen without making any changes
- `--force`: Overwrites target file if it already exists

### User Experience

- Improved output to show file renaming details and title changes
- Clear error messages for common failure scenarios (file exists, invalid paths, etc.)

## Testing

- Manually tested with various combinations of task formats and options
- Verified both title formats work correctly
- Verified file renaming works as expected
- Verified error handling for existing files works correctly with and without --force

## Related

- Closes #032: Auto-Rename Task Spec Files in `tasks create` Command
- Closes #035: Fix Task Creation Workflow to Not Require Task Number in Spec Title 
