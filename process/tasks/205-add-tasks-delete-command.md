# Task 205: Add `minsky tasks delete` Command

## Status

BACKLOG

## Priority

MEDIUM

## Description

The Minsky CLI currently lacks a command to delete tasks. While tasks can be created, listed, and updated, there's no built-in way to remove tasks that are no longer needed, cancelled, or created in error. Adding a `tasks delete` command would complete the CRUD operations for task management and improve workflow efficiency.

## Requirements

### Command Interface

```bash
# Delete a single task by ID
minsky tasks delete <task-id>

# Delete a single task by ID (alternative syntax)
minsky tasks delete --task-id <task-id>

# Force deletion without confirmation prompt
minsky tasks delete <task-id> --force

# Delete with JSON output
minsky tasks delete <task-id> --json

# Multiple tasks deletion (stretch goal)
minsky tasks delete <task-id1> <task-id2> <task-id3>
```

### Core Functionality

1. **Task Deletion Logic**

   - Remove task from the task backend (e.g., remove line from `process/tasks.md` for markdown backend)
   - Delete associated task specification file (e.g., `process/tasks/{id}-{slug}.md`)
   - Handle different backends consistently (markdown, json-file, github-issues)
   - Verify task exists before attempting deletion

2. **Safety and Confirmation**

   - Show confirmation prompt by default (similar to `minsky session delete`)
   - Display task details before deletion to confirm user intent
   - Support `--force` flag to skip confirmation for automated usage
   - Provide clear success/failure messages

3. **Error Handling**

   - Handle case where task ID doesn't exist
   - Handle file system permissions errors
   - Handle backend-specific errors (e.g., GitHub API errors)
   - Provide informative error messages

4. **Integration with Existing Architecture**
   - Follow existing command patterns from `tasks create`, `tasks get`, etc.
   - Use shared command registry architecture
   - Support common options: `--session`, `--repo`, `--workspace`, `--backend`, `--json`
   - Add both CLI and MCP tool support

## Implementation Details

### Domain Layer Updates

1. **TaskBackend Interface Extension**

   ```typescript
   interface TaskBackend {
     // ... existing methods
     deleteTask(taskId: string, options?: DeleteTaskOptions): Promise<boolean>;
   }
   ```

2. **TaskService Method**

   ```typescript
   async deleteTask(taskId: string, options: DeleteTaskOptions = {}): Promise<boolean>
   ```

3. **Backend Implementations**
   - `MarkdownTaskBackend`: Remove from tasks.md and delete spec file
   - `JsonFileTaskBackend`: Remove from JSON storage
   - `GitHubTaskBackend`: Close/delete GitHub issue (if supported)

### Command Registration

1. **Shared Commands** (`src/adapters/shared/commands/tasks.ts`)

   - Add `tasksDeleteParams` parameter map
   - Add `tasksDeleteRegistration` command definition
   - Register in `registerTasksCommands()` function

2. **CLI Customization** (`src/adapters/cli/cli-command-factory.ts`)

   - Add CLI-specific parameter configuration
   - Configure argument handling for task ID

3. **MCP Integration** (`src/adapters/mcp/tasks.ts`)
   - Add `delete` command to MCP task tools
   - Follow existing MCP command patterns

### Schema Definition

```typescript
export const taskDeleteParamsSchema = z
  .object({
    taskId: z.string().min(1).describe("ID of the task to delete"),
    force: flagSchema("Force deletion without confirmation"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (markdown, json-file, github-issues)"),
  })
  .merge(commonCommandOptionsSchema);
```

## Success Criteria

- [ ] `minsky tasks delete <task-id>` successfully deletes an existing task
- [ ] Command shows confirmation prompt with task details before deletion
- [ ] `--force` flag skips confirmation prompt
- [ ] `--json` flag outputs deletion result in JSON format
- [ ] Task is removed from both the task list and the specification file is deleted
- [ ] Command works with all supported backends (markdown, json-file, github-issues)
- [ ] Proper error handling for non-existent tasks
- [ ] Integration with CLI bridge and MCP server
- [ ] All existing tests continue to pass
- [ ] New functionality has comprehensive test coverage

## Dependencies

- Understanding of existing TaskService and TaskBackend architecture
- Familiarity with shared command registry pattern
- Knowledge of CLI and MCP adapter integration patterns
- Consistency with existing `session delete` command patterns

## Implementation Notes

1. **Follow Existing Patterns**

   - Model after `session delete` command for confirmation and safety
   - Use same parameter patterns as other task commands
   - Follow shared command registry architecture

2. **Safety Considerations**

   - Always confirm before deletion unless `--force` is used
   - Show task title and ID in confirmation prompt
   - Consider soft-delete vs hard-delete based on backend capabilities

3. **Backend Variations**

   - Markdown: Remove from tasks.md, delete spec file
   - JSON: Remove from JSON storage
   - GitHub: Close issue (deletion may not be supported by GitHub API)

4. **Testing Strategy**
   - Unit tests for domain logic
   - Integration tests for command execution
   - Test all backends and error conditions
   - Test confirmation prompts and force flag

## Related Tasks

- Task #052: Add remaining task management commands to MCP (mentioned tasks.delete)
- Task #100: Align MCP API with CLI implementation (mentioned delete command)
- Task #015: Add session delete command (provides pattern reference)
- Task #163: Add title/description options to tasks create (shows command evolution pattern)
