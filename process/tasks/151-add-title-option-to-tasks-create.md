# Task #151: Add --title Option to Tasks Create Command

## Context

The `minsky tasks create` command currently only accepts a `specPath` argument, forcing users to create a specification file manually. A simple `--title` option would allow quick task creation without requiring a pre-written file.

## Problem Statement

Users want to create tasks quickly with just a title, like:
```bash
minsky tasks create --title "Fix the login bug"
```

Currently this requires creating a full specification file first, which is unnecessarily heavyweight for simple tasks.

## Requirements

### Simple Enhancement
- Add `--title` parameter to `tasks create` command
- Make `--title` required when `specPath` is not provided
- When `--title` is used, auto-generate a basic specification file
- Keep existing `specPath` behavior unchanged

### Command Behavior
```bash
# New: Quick creation with title
minsky tasks create --title "Fix login validation"

# Existing: Still works unchanged  
minsky tasks create process/tasks/complex-feature.md

# Error: Neither provided
minsky tasks create  # Should show error asking for --title or specPath
```

### Auto-Generated Specification
When using `--title`, generate a minimal specification file:
- Auto-assign next available task ID
- Create file as `process/tasks/{id}-{slugified-title}.md`
- Use simple template with title and basic structure

## Technical Implementation

### Update Command Parameters
```typescript
const tasksCreateParams: CommandParameterMap = {
  specPath: {
    schema: z.string().optional(), // Make optional when title provided
    description: "Path to the task specification document",
    required: false,
  },
  title: {
    schema: z.string().min(1),
    description: "Task title (required when specPath not provided)",
    required: false, // Conditional requirement
  },
  // ... existing options unchanged
};
```

### Validation Logic
- Ensure either `specPath` OR `title` is provided (not both, not neither)
- If `title` provided, generate specification file automatically
- If `specPath` provided, use existing behavior

### Basic Template
Generated specification should be minimal:
```markdown
# Task #{id}: {title}

## Context

{title}

## Requirements

- [ ] TODO: Define requirements

## Acceptance Criteria

- [ ] TODO: Define acceptance criteria
```

## Acceptance Criteria

- [ ] `minsky tasks create --title "Some task"` creates task with auto-generated spec
- [ ] Auto-numbering assigns correct next task ID  
- [ ] Generated file follows naming convention: `{id}-{slugified-title}.md`
- [ ] Existing `minsky tasks create path/to/spec.md` behavior unchanged
- [ ] Error when neither `--title` nor `specPath` provided
- [ ] Error when both `--title` and `specPath` provided
- [ ] Generated specification file is properly formatted
- [ ] Task appears in listings immediately after creation

## Notes

This is a minimal enhancement focused only on adding a `--title` option for quick task creation, without adding complexity like priorities, labels, or other metadata. 
