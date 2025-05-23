# feat(#129): Implement Local DB Tasks Backend with JSON Storage

## Summary

This PR implements Task #129, creating a robust local database tasks backend that eliminates synchronization issues between sessions and workspaces. The implementation provides a complete storage abstraction layer with a JSON file backend, comprehensive migration utilities, and seamless TaskService integration while maintaining full backward compatibility.

## Motivation & Context

The existing file-based approach using `tasks.md` creates synchronization challenges when working across multiple sessions or workspaces. Specifically:

1. **Cross-session synchronization issues**: Changes to `tasks.md` in one session don't reflect in other sessions or the main workspace
2. **Out-of-date task information**: Working in different contexts leads to stale task data
3. **Task ID conflicts**: Lack of centralized coordination can cause duplicate or conflicting task IDs
4. **Performance limitations**: Markdown parsing is slower than direct object access for frequent operations

Task #129 addresses these issues by implementing a centralized JSON database approach similar to the existing SessionDB pattern, stored at `~/.local/state/minsky/tasks.json`.

## Design/Approach

The implementation follows a layered architecture design that prioritizes:

1. **Storage Abstraction**: Generic `DatabaseStorage` interface supporting multiple backend types
2. **Type Safety**: Full TypeScript generics ensuring compile-time type checking across all operations
3. **Future Extensibility**: Architecture supports transparent upgrades to SQLite, PostgreSQL, or other databases
4. **Backward Compatibility**: Existing markdown workflows continue to work unchanged
5. **Data Integrity**: Atomic file operations prevent corruption during concurrent access

The design deliberately separates concerns between storage operations (DatabaseStorage), business logic (JsonFileTaskBackend), and service orchestration (TaskService integration).

## Key Changes

### Storage Abstraction Layer

- **DatabaseStorage interface** (`src/domain/storage/database-storage.ts`): Generic storage interface with CRUD operations, error handling, and query capabilities
- **JsonFileStorage implementation** (`src/domain/storage/json-file-storage.ts`): Thread-safe JSON file operations with atomic writes and configurable initialization

### Task Backend Implementation

- **JsonFileTaskBackend** (`src/domain/tasks/jsonFileTaskBackend.ts`): Complete TaskBackend interface implementation using DatabaseStorage abstraction
- **Enhanced parseTaskSpec method**: Proper task ID extraction from specification files (fixes auto-increment vs. spec ID issues)
- **Database-specific methods**: Direct CRUD operations (getAllTasks, getTaskById, createTaskData, updateTaskData, deleteTaskData)

### Migration & Compatibility

- **Migration utilities** (`src/domain/tasks/migration-utils.ts`): Bidirectional markdown ↔ JSON conversion with backup creation and conflict resolution
- **Markdown compatibility**: JsonFileTaskBackend can parse existing markdown task formats for seamless migration

### TaskService Integration

- **Multi-backend support**: TaskService supports both "json-file" and "markdown" backends simultaneously
- **Configurable backend selection**: Users can choose backend via `--backend` flag
- **Backward compatibility**: Existing CLI commands continue to work without changes

## CLI Usage Examples

### Basic Task Operations with JSON Backend

    # List tasks using JSON backend (when configured as default)
    minsky tasks list

    # Explicitly specify JSON backend
    minsky tasks list --backend json-file

    # Create and manage tasks (same commands work with both backends)
    minsky tasks create process/tasks/new-feature.md
    minsky tasks status set #123 IN-PROGRESS
    minsky tasks status get #123

### Backend Switching

    # Use markdown backend explicitly
    minsky tasks list --backend markdown

    # Set task status with specific backend
    minsky tasks status set #123 DONE --backend json-file

### Cross-Session Verification

    # In Session A
    minsky tasks status set #123 IN-PROGRESS --backend json-file

    # In Session B (immediately visible)
    minsky tasks status get #123 --backend json-file
    # Output: IN-PROGRESS

## Code Examples

### Storage Interface Usage

<pre><code class="language-typescript">
// Generic storage interface
interface DatabaseStorage&lt;T, S&gt; {
  initialize(): Promise&lt;boolean&gt;;
  getEntities(): Promise&lt;T[]&gt;;
  createEntity(entity: T): Promise&lt;T&gt;;
  updateEntity(id: string, updates: Partial&lt;T&gt;): Promise&lt;T | null&gt;;
  deleteEntity(id: string): Promise&lt;boolean&gt;;
  readState(): Promise&lt;DatabaseReadResult&lt;S&gt;&gt;;
  writeState(state: S): Promise&lt;DatabaseWriteResult&gt;;
}

// Usage with TaskData
const storage = createJsonFileStorage&lt;TaskData, TaskState&gt;({
  filePath: "~/.local/state/minsky/tasks.json",
  entitiesField: "tasks",
  idField: "id",
  initializeState: () => ({
    tasks: [],
    lastUpdated: new Date().toISOString(),
    metadata: {}
  })
});
</code></pre>

### TaskService Backend Configuration

<pre><code class="language-typescript">
// Default configuration (markdown backend for backward compatibility)
const taskService = new TaskService();

// Explicit backend selection
const taskService = new TaskService({
  backend: "json-file",  // or "markdown"
  workspacePath: "/path/to/workspace"
});

// Custom backend setup
const customBackend = createJsonFileTaskBackend({
  name: "json-file",
  workspacePath: process.cwd(),
  dbFilePath: "/custom/path/tasks.json"
});

const taskService = new TaskService({
  customBackends: [customBackend],
  backend: "json-file"
});
</code></pre>

### Migration Example

<pre><code class="language-typescript">
// Migrate existing tasks.md to JSON format
const migrationUtils = createMigrationUtils({
  workspacePath: "/path/to/workspace",
  createBackup: true,
  preserveOriginal: true
});

const result = await migrationUtils.migrateToJson();
if (result.success) {
  console.log(`Migrated ${result.tasksMigrated} tasks to JSON format`);
}
</code></pre>

## Breaking Changes

None. All changes maintain complete backward compatibility:

- Existing `tasks.md` files continue to work with the markdown backend (which remains the default)
- All CLI commands function identically with both backends
- TaskService API remains unchanged
- Migration is opt-in and non-destructive

## Data Migrations

- **Gradual adoption**: New installations can opt into JSON backend; existing installations continue using markdown until manually migrated
- **Migration utilities**: Provide safe, backup-protected conversion between formats
- **Format detection**: JsonFileTaskBackend can parse both JSON and markdown formats for smooth transitions
- **Rollback support**: Migration utilities support bidirectional conversion for easy rollback

## Ancillary Changes

- **Enhanced error handling**: Improved error recovery and logging throughout the storage layer
- **Test infrastructure improvements**: Added unique database paths per test to prevent cross-test contamination
- **TypeScript compliance**: Resolved all linter issues including import styles and type safety
- **Session workspace compatibility**: All components work correctly in session-based development environments
- **File restoration process**: Addressed missing implementation files issue through careful git history analysis

## Testing

Comprehensive test coverage with **28 passing tests** across multiple test suites, providing both direct storage testing and integration verification:

### JsonFileStorage Core Tests (8 tests) - NEW

Direct testing of the storage abstraction layer:

- **Core CRUD Operations**: Entity creation, retrieval, updates, and deletion
- **State Management**: Direct state read/write operations with custom state objects
- **Error Handling**: Graceful handling of non-existent entities across all operations
- **Persistence**: Cross-instance data persistence and storage location management

### JsonFileTaskBackend Tests (12 tests)

- **Storage operations**: Initialize, store/retrieve, update, delete tasks
- **TaskBackend interface compliance**: getTasksData, saveTasksData, parseTasks, formatTasks
- **Task specification operations**: Reading, parsing, and saving spec files
- **Markdown compatibility**: Parsing existing markdown task formats
- **Helper methods**: Path generation, workspace management

### TaskService Integration Tests (8 tests)

- **Basic operations**: Backend selection, task listing, creation, retrieval
- **Status management**: Updating and filtering tasks by status
- **Error handling**: Invalid task IDs, status validation
- **Cross-instance persistence**: Ensuring changes persist across service instances
- **Backend switching**: Verification that both backends work correctly

### Test Infrastructure & Quality

- **Complete isolation**: Each test uses unique database file paths to prevent contamination
- **Proper cleanup**: Robust test teardown avoiding cross-test interference
- **API correctness**: All tests use correct DatabaseStorage interface methods
- **Project standards**: Uses centralized test utilities (expectToHaveLength) for consistency
- **Real-world scenarios**: Integration tests cover actual CLI usage patterns

## Performance Benefits

- **Faster parsing**: JSON parsing significantly faster than markdown processing
- **Direct queries**: Object access eliminates text-based search operations
- **Reduced I/O**: Centralized storage reduces file system operations
- **Concurrent access**: Thread-safe atomic operations support multiple sessions
- **Cross-session sync**: Immediate visibility of changes across all sessions and workspaces

## Future Extensibility

The generic `DatabaseStorage` interface enables transparent upgrades:

    Current: JsonFileTaskBackend → JsonFileStorage → JSON file
    Future:  SqliteTaskBackend → SqliteStorage → SQLite database
            PostgresTaskBackend → PostgresStorage → PostgreSQL database

All business logic in JsonFileTaskBackend and TaskService remains unchanged when switching storage backends.

## Implementation Statistics

- **4 new core modules**: DatabaseStorage, JsonFileStorage, JsonFileTaskBackend, Migration utilities
- **380+ lines of documentation**: Comprehensive implementation guide and migration documentation
- **28 passing tests**: Complete test coverage across all functionality layers
- **Zero breaking changes**: Full backward compatibility maintained
- **Future-ready architecture**: Supports transparent database upgrades
- **Production ready**: Comprehensive error handling and data integrity safeguards
