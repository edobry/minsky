# Task 163: Add --title and --description Options to tasks create Command

## Status

BACKLOG

## Priority

MEDIUM

## Description

Update the `minsky tasks create` command to require `--title` and `--description` options, making it consistent with the `minsky session pr` command interface. This will improve usability by allowing users to create tasks directly from the command line without needing to create a specification file first.

## Objectives

1. **Add Required Options to tasks create Command**

   - Add `--title` option that accepts the task title
   - Add `--description` option that accepts the task description
   - Make both options required when creating tasks

2. **Maintain Backward Compatibility**

   - Keep the existing `<specPath>` argument for file-based task creation
   - Support both approaches: file-based and option-based task creation
   - Ensure existing workflows continue to work

3. **Consistent CLI Interface**
   - Match the pattern used by `minsky session pr` command
   - Follow established CLI conventions for option naming and behavior
   - Provide clear error messages when required options are missing

## Requirements

### Command Interface

```bash
# New option-based approach (required options)
minsky tasks create --title "Task Title" --description "Task description"

# Existing file-based approach (should still work)
minsky tasks create path/to/task-spec.md

# Error cases
minsky tasks create --title "Title" # Error: --description is required
minsky tasks create --description "Desc" # Error: --title is required
minsky tasks create # Error: Either specify title/description or spec file path
```

### Implementation Details

1. **Command Argument Validation**

   - If `<specPath>` is provided, use file-based creation (existing behavior)
   - If `--title` and `--description` are provided, use option-based creation
   - If neither or partial options are provided, show clear error message
   - Validate that title and description are non-empty strings

2. **Task Specification Generation**

   - Generate a markdown task specification from the provided title and description
   - Use a standard template format consistent with existing tasks
   - Auto-assign the next available task number
   - Set default status to BACKLOG and priority to MEDIUM

3. **File Management**
   - Create the task file in the standard location: `process/tasks/{number}-{slug}.md`
   - Generate appropriate filename slug from the title
   - Ensure the task file follows the established format

### Template for Generated Tasks

```markdown
# Task {number}: {title}

## Status

BACKLOG

## Priority

MEDIUM

## Description

{description}

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
```

## Implementation Notes

1. **Code Location**

   - Update the tasks create command handler in the CLI adapter
   - Likely in `src/adapters/cli/commands/tasks/` or similar location

2. **Error Handling**

   - Provide clear, actionable error messages
   - Handle edge cases like special characters in titles
   - Validate file system permissions for task creation

3. **Testing**
   - Add tests for both option-based and file-based task creation
   - Test error conditions and validation
   - Ensure backward compatibility is maintained

## Dependencies

- Understanding of existing `minsky tasks create` command implementation
- Familiarity with `minsky session pr` command interface patterns
- Access to CLI command structure and argument parsing

## Success Criteria

- `minsky tasks create --title "Title" --description "Description"` creates a valid task
- Both `--title` and `--description` options are required
- Existing file-based task creation continues to work unchanged
- Generated task files follow the established format and conventions
- Clear error messages are provided for invalid usage
- All existing tests continue to pass
- New functionality is properly tested

## Notes

This enhancement will significantly improve the developer experience by allowing quick task creation directly from the command line, similar to how `minsky session pr` works for PR creation. The dual approach (file-based and option-based) provides flexibility for different workflows while maintaining backward compatibility.
