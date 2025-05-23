# JSON Task Backend Documentation

## Overview

The JSON Task Backend is a new storage implementation for Minsky that provides centralized, synchronized task management across multiple sessions and workspaces. It replaces the traditional `tasks.md` file-based approach with a JSON database stored in a centralized location.

## Architecture

### Core Components

#### 1. DatabaseStorage Abstraction (`src/domain/storage/database-storage.ts`)
Generic interface for database operations supporting any storage backend:
- **Type-safe**: Generic types for entity (T) and state (S)
- **CRUD operations**: Create, Read, Update, Delete with proper error handling
- **Query capabilities**: Filtering and batch operations
- **Future-proof**: Easy to extend for SQLite, PostgreSQL, etc.

#### 2. JsonFileStorage Implementation (`src/domain/storage/json-file-storage.ts`)
Concrete implementation for JSON file storage:
- **Thread-safe operations**: Atomic writes and proper file locking
- **Configurable paths**: Flexible file location configuration
- **Error recovery**: Comprehensive error handling and recovery mechanisms
- **Performance optimized**: Efficient JSON serialization and parsing

#### 3. JsonFileTaskBackend (`src/domain/tasks/jsonFileTaskBackend.ts`)
TaskBackend implementation using the storage abstraction:
- **Interface compliance**: Implements existing TaskBackend interface
- **Backward compatibility**: Supports markdown parsing for migration
- **Enhanced operations**: Additional database-specific methods

#### 4. Migration Utilities (`src/domain/tasks/migration-utils.ts`)
Tools for transitioning between storage formats:
- **Bidirectional conversion**: Markdown ↔ JSON
- **Backup creation**: Safety mechanisms during migration
- **Conflict resolution**: Handles duplicate tasks and sync issues

## Benefits

### 🔄 **Synchronized Access**
- Tasks are stored in a centralized JSON database
- Changes in any workspace/session are immediately visible everywhere
- Eliminates the synchronization issues of `tasks.md` files

### 🏗️ **Future-Proof Architecture**
- Clean separation between business logic and storage
- Easy to upgrade from JSON files to SQLite or other databases
- No business logic changes required for storage upgrades

### 🛡️ **Type Safety**
- Full TypeScript support with generic interfaces
- Compile-time type checking for all operations
- Reduced runtime errors and improved developer experience

### ⚡ **Performance**
- Efficient JSON operations with atomic writes
- Minimal file I/O operations
- Optimized for concurrent access patterns

## Storage Location

By default, tasks are stored at:
```
~/.local/state/minsky/tasks.json
```

This can be customized when creating the backend:
```typescript
const backend = createJsonFileTaskBackend({
  name: "json-file",
  workspacePath: "/path/to/workspace",
  dbFilePath: "/custom/path/to/tasks.json"
});
```

## Data Format

The JSON database uses the following structure:

```json
{
  "tasks": [
    {
      "id": "#001",
      "title": "Implement feature X",
      "description": "Description of the task",
      "status": "TODO",
      "specPath": "process/tasks/001-implement-feature-x.md",
      "worklog": [
        {
          "timestamp": "2025-01-22T19:30:00.000Z",
          "message": "Initial creation"
        }
      ],
      "mergeInfo": {
        "commitHash": "abc123",
        "mergeDate": "2025-01-22T20:00:00.000Z",
        "mergedBy": "developer",
        "baseBranch": "main",
        "prBranch": "feature/task-001"
      }
    }
  ],
  "lastUpdated": "2025-01-22T19:30:00.000Z",
  "metadata": {
    "migratedFrom": "/path/to/tasks.md",
    "migrationDate": "2025-01-22T19:30:00.000Z"
  }
}
```

## Usage

### Creating a JsonFileTaskBackend

```typescript
import { createJsonFileTaskBackend } from "./domain/tasks/jsonFileTaskBackend.js";

const backend = createJsonFileTaskBackend({
  name: "json-file",
  workspacePath: process.cwd(),
  dbFilePath: "/custom/path/tasks.json" // Optional
});
```

### Basic Operations

```typescript
// Create a task
const task = await backend.createTaskData({
  id: "#123",
  title: "New Task",
  status: "TODO",
  description: "Task description"
});

// Retrieve a task
const retrieved = await backend.getTaskById("#123");

// Update a task
const updated = await backend.updateTaskData("#123", { 
  status: "IN-PROGRESS" 
});

// Delete a task
const deleted = await backend.deleteTaskData("#123");

// Get all tasks
const allTasks = await backend.getAllTasks();
```

### Integration with TaskService

```typescript
import { TaskService } from "./domain/tasks/taskService.js";
import { createJsonFileTaskBackend } from "./domain/tasks/jsonFileTaskBackend.js";

const jsonBackend = createJsonFileTaskBackend({
  name: "json-file",
  workspacePath: process.cwd()
});

const taskService = new TaskService({
  backend: "json-file",
  customBackends: [jsonBackend]
});
```

## Migration

### From Markdown to JSON

```typescript
import { migrateWorkspaceToJson } from "./domain/tasks/migration-utils.js";

const result = await migrateWorkspaceToJson("/path/to/workspace", {
  targetDbPath: "/custom/path/tasks.json", // Optional
  createBackup: true, // Default: true
  preserveOriginal: true // Default: true
});

if (result.success) {
  console.log(`Migrated ${result.tasksMigrated} tasks`);
  console.log(`Database: ${result.newDbFile}`);
  console.log(`Backup: ${result.backupFile}`);
} else {
  console.error("Migration failed:", result.error);
}
```

### From JSON back to Markdown

```typescript
import { migrateWorkspaceFromJson } from "./domain/tasks/migration-utils.js";

const result = await migrateWorkspaceFromJson("/path/to/workspace", {
  targetDbPath: "/path/to/tasks.json",
  createBackup: true
});
```

### Migration Utilities

```typescript
import { createMigrationUtils } from "./domain/tasks/migration-utils.js";

const utils = createMigrationUtils({
  workspacePath: "/path/to/workspace",
  targetDbPath: "/path/to/tasks.json"
});

// Compare formats to detect sync issues
const comparison = await utils.compareFormats();
console.log("Tasks only in markdown:", comparison.differences.onlyInMarkdown);
console.log("Tasks only in JSON:", comparison.differences.onlyInJson);
console.log("Different tasks:", comparison.differences.different);
```

## Supported Task Formats

The migration utilities support multiple markdown task formats:

### Format 1: Title with ID and link
```markdown
- [ ] Implement feature X [#001](process/tasks/001-implement-feature-x.md)
- [x] Fix bug Y [#002](process/tasks/002-fix-bug-y.md)
```

### Format 2: Link with ID
```markdown
- [ ] [Implement feature X](process/tasks/001-implement-feature-x.md) [#001]
- [x] [Fix bug Y](process/tasks/002-fix-bug-y.md) [#002]
```

### Format 3: Simple format with ID
```markdown
- [ ] Implement feature X #001
- [x] Fix bug Y #002
```

## Error Handling

All operations return result objects with proper error information:

```typescript
// Storage operations
const result = await backend.getTasksData();
if (!result.success) {
  console.error("Failed to read tasks:", result.error);
  console.log("File path:", result.filePath);
}

// Migration operations
const migrationResult = await migrateWorkspaceToJson(workspacePath);
if (!migrationResult.success) {
  console.error("Migration failed:", migrationResult.error);
  console.log("Tasks migrated:", migrationResult.tasksMigrated);
  console.log("Backup file:", migrationResult.backupFile);
}
```

## Performance Considerations

### File Operations
- JSON files are read/written atomically
- Directory structure is created automatically
- File locks prevent concurrent write conflicts

### Memory Usage
- Tasks are loaded into memory for operations
- Efficient JSON parsing and serialization
- Suitable for typical project task volumes (hundreds to thousands of tasks)

### Concurrent Access
- Multiple processes can read simultaneously
- Write operations are serialized through file system locks
- Last-write-wins for concurrent modifications

## Future Enhancements

The architecture supports seamless upgrades to more advanced storage:

### SQLite Backend
```typescript
// Future implementation
const sqliteBackend = createSqliteTaskBackend({
  name: "sqlite",
  workspacePath: process.cwd(),
  dbPath: "~/.local/state/minsky/tasks.db"
});

// Same interface, different implementation
const task = await sqliteBackend.createTaskData(taskData);
```

### PostgreSQL Backend
```typescript
// Future implementation
const pgBackend = createPostgreSQLTaskBackend({
  name: "postgresql",
  workspacePath: process.cwd(),
  connectionString: "postgresql://user:pass@localhost/minsky"
});
```

## Troubleshooting

### Migration Issues

**Problem**: Migration fails with "tasks.md not found"
**Solution**: Ensure the workspace path contains a `process/tasks.md` file

**Problem**: Permission errors during migration
**Solution**: Check write permissions for the target database path

**Problem**: Corrupted JSON database
**Solution**: Use migration utilities to restore from backup or recreate from tasks.md

### Performance Issues

**Problem**: Slow task operations
**Solution**: Check file system performance and disk space

**Problem**: High memory usage
**Solution**: Consider implementing pagination for very large task sets

### Synchronization Issues

**Problem**: Tasks not appearing in other sessions
**Solution**: Verify all sessions are using the same database path

**Problem**: Conflicting task modifications
**Solution**: The system uses last-write-wins; implement manual conflict resolution if needed

## Testing

Basic test suite is provided in `src/domain/tasks/__tests__/jsonFileTaskBackend.test.ts`:

```bash
# Run tests
bun test src/domain/tasks/__tests__/jsonFileTaskBackend.test.ts
```

The tests cover:
- Storage operations (CRUD)
- TaskBackend interface compliance
- Markdown compatibility
- Helper methods
- Error handling

## Implementation Status

### ✅ Completed
- DatabaseStorage abstraction interface
- JsonFileStorage implementation
- JsonFileTaskBackend with full TaskBackend compliance
- Migration utilities (markdown ↔ JSON)
- Basic test suite
- Documentation

### 🔄 In Progress
- Integration with existing TaskService
- CLI command updates
- Comprehensive test coverage

### 📋 Future Work
- SQLite backend implementation
- Advanced query capabilities
- Real-time synchronization
- Conflict resolution strategies
- Performance optimizations for large datasets

## Contributing

When extending the JSON Task Backend:

1. **Maintain interface compliance**: Ensure new features implement existing interfaces
2. **Add comprehensive tests**: Test both success and error scenarios
3. **Update documentation**: Keep this README current with changes
4. **Consider backward compatibility**: Existing migrations should continue to work
5. **Follow type safety**: Use TypeScript generics and proper error handling 
