# Task #150: Enhance Tasks Create Command with User-Friendly Options

## Context

The current `minsky tasks create` command only accepts a `specPath` argument, requiring users to manually create a full specification file before creating a task. This is cumbersome for quick task creation and doesn't follow modern CLI UX patterns.

## Problem Statement

Current limitations:
- Must create a full markdown specification file before creating a task
- No quick task creation workflow
- Inconsistent with other modern CLI tools that support inline options
- Forces users into a heavyweight workflow for simple tasks

## Requirements

### Enhanced Command Interface

Support two modes of task creation:

#### 1. Quick Creation Mode (New)
```bash
# Required title
minsky tasks create --title "Fix the login bug"

# With optional description  
minsky tasks create --title "Add user authentication" --description "Implement JWT-based auth system with refresh tokens"

# With additional metadata
minsky tasks create --title "Database migration" --description "Migrate to PostgreSQL" --priority high --labels "backend,database"
```

#### 2. Specification File Mode (Existing) 
```bash
# Keep current behavior for detailed specifications
minsky tasks create process/tasks/123-complex-feature.md
```

### New Command Options

- `--title` (required when not using specPath): Task title/summary
- `--description` (optional): Task description/context  
- `--priority` (optional): Task priority (low, medium, high, critical)
- `--labels` (optional): Comma-separated labels/tags
- `--status` (optional): Initial status (defaults to TODO)
- `--assignee` (optional): Task assignee
- `--due-date` (optional): Due date in YYYY-MM-DD format

### Auto-Generated Specification Files

When using quick creation mode:
- Generate a proper specification file automatically
- Use a template with sections: Context, Requirements, Acceptance Criteria
- Place in appropriate `process/tasks/` directory with correct naming
- Include all provided metadata in structured format

### Improved User Experience

- **Validation**: Ensure title is provided (either via `--title` or by parsing specPath)
- **Interactive Prompts**: When title not provided, prompt for it (don't fail silently)
- **Auto-numbering**: Automatically assign next available task ID
- **Template Support**: Allow different task templates (feature, bug, chore, etc.)
- **Rich Output**: Show created task details including generated file path

## Technical Implementation

### Command Signature Updates

```typescript
// New parameters to add to tasksCreateParams
const tasksCreateParams: CommandParameterMap = {
  // Existing
  specPath: {
    schema: z.string().optional(), // Make optional when title provided
    description: "Path to the task specification document",
    required: false, // Changed from true
  },
  
  // New quick creation options
  title: {
    schema: z.string().min(1),
    description: "Task title (required when not using specPath)",
    required: false, // Conditional requirement
  },
  description: {
    schema: z.string(),
    description: "Task description/context",
    required: false,
  },
  priority: {
    schema: z.enum(["low", "medium", "high", "critical"]),
    description: "Task priority level",
    required: false,
  },
  labels: {
    schema: z.string(),
    description: "Comma-separated labels/tags",
    required: false,
  },
  status: {
    schema: z.enum(["TODO", "IN-PROGRESS", "IN-REVIEW", "DONE", "BLOCKED"]),
    description: "Initial task status",
    required: false,
    defaultValue: "TODO",
  },
  assignee: {
    schema: z.string(),
    description: "Task assignee",
    required: false,
  },
  dueDate: {
    schema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: "Due date in YYYY-MM-DD format",
    required: false,
  },
  template: {
    schema: z.enum(["feature", "bug", "chore", "research", "epic"]),
    description: "Task template type",
    required: false,
    defaultValue: "feature",
  },
  
  // Existing options remain unchanged
  force: { ... },
  backend: { ... },
  // etc.
};
```

### Domain Logic Updates

#### New Function: `createTaskFromMetadata`
```typescript
export async function createTaskFromMetadata(params: {
  title: string;
  description?: string;
  priority?: string;
  labels?: string[];
  status?: string;
  assignee?: string;
  dueDate?: string;
  template?: string;
  workspacePath: string;
  backend?: string;
}): Promise<{ task: any; specPath: string }>;
```

#### Enhanced `createTaskFromParams`
- Support both specPath and metadata-based creation
- Auto-generate specification files for metadata mode
- Validate that either specPath OR title is provided
- Use templates for different task types

### Template System

Create task templates in `src/templates/tasks/`:
- `feature.md` - Feature development tasks
- `bug.md` - Bug fix tasks  
- `chore.md` - Maintenance tasks
- `research.md` - Research/investigation tasks
- `epic.md` - Large epic tasks

### File Generation Logic

- **Auto-numbering**: Scan existing tasks to find next available ID
- **Naming convention**: `{id}-{slugified-title}.md`
- **Directory placement**: `process/tasks/`
- **Template population**: Fill template with provided metadata

## Acceptance Criteria

### Quick Creation Mode
- [ ] `minsky tasks create --title "Fix bug"` creates task with auto-generated spec file
- [ ] All optional metadata options work correctly
- [ ] Auto-numbering assigns correct next task ID
- [ ] Generated specification file follows proper template format
- [ ] Task appears in task listings immediately after creation

### Validation & Error Handling
- [ ] Error when neither `specPath` nor `--title` provided
- [ ] Interactive prompt for title when missing in TTY environment
- [ ] Clear error messages for invalid option combinations
- [ ] Validation for date formats, enum values, etc.

### Backward Compatibility  
- [ ] Existing `minsky tasks create path/to/spec.md` workflow unchanged
- [ ] All existing flags and options continue to work
- [ ] No breaking changes to API or CLI interface

### User Experience
- [ ] Rich output showing created task details
- [ ] Help text explains both creation modes clearly
- [ ] Examples in help demonstrate common usage patterns
- [ ] Generated files are properly formatted and readable

### Templates & Customization
- [ ] Different task templates generate appropriate sections
- [ ] Templates can be customized per repository
- [ ] Template selection affects generated specification structure

## Testing Strategy

- [ ] Unit tests for metadata-to-specification conversion
- [ ] Integration tests for both creation modes
- [ ] CLI tests for all new command options
- [ ] Backward compatibility tests for existing workflows
- [ ] Error handling tests for edge cases
- [ ] Template system tests

## Example Usage

```bash
# Quick bug creation
minsky tasks create --title "Login form validation error" --priority high --labels "frontend,bug"

# Feature with description
minsky tasks create --title "User dashboard" --description "Create responsive dashboard with charts and user stats" --template feature --due-date "2024-07-01"

# Research task
minsky tasks create --title "Evaluate React 19 features" --template research --assignee "john@example.com"

# Still works - existing mode
minsky tasks create process/tasks/complex-migration.md
```

This enhancement makes Minsky's task creation as smooth as modern tools like GitHub CLI, Jira CLI, or Linear CLI. 
