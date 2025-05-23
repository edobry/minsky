# Task #129: Implement Local DB Tasks Backend

## Context

The current Minsky CLI uses a file-based approach (`tasks.md`) as its default task management backend, with a placeholder for a GitHub backend. This approach creates synchronization challenges when working across multiple sessions or workspaces. Specifically:

1. When a user edits the `tasks.md` file in a session, those changes are not reflected in other sessions or in the main workspace
2. This can lead to out-of-date task information when working in different contexts
3. Sometimes conflicting task IDs can occur due to this lack of synchronization

We need a more robust backend similar to the SessionDB, which already uses a local JSON file stored in a centralized location.

## Requirements

1. **Create a DatabaseStorage abstraction layer** that can support multiple storage backends (JSON file, SQLite, etc.)
2. **Implement JsonFileTaskBackend** using the abstraction to store tasks in a JSON file at `~/.local/state/minsky/tasks.json`
3. **Provide migration utilities** to convert existing `tasks.md` files to the new JSON format
4. **Maintain API compatibility** with the existing TaskBackend interface
5. **Support transparent upgrades** to other database backends (e.g., SQLite) in the future
6. **Ensure synchronization** across multiple sessions and workspaces

## Implementation Steps

### Phase 1: Storage Abstraction Layer ✅ COMPLETED
- [x] **Create DatabaseStorage interface** (`src/domain/storage/database-storage.ts`)
  - Generic interface supporting any entity and state types
  - CRUD operations with proper error handling
  - Query capabilities and batch operations
- [x] **Implement JsonFileStorage** (`src/domain/storage/json-file-storage.ts`)
  - Concrete implementation for JSON file storage
  - Thread-safe operations with atomic writes
  - Configurable paths and initialization
- [x] **Create migration utilities** (`src/domain/tasks/migration-utils.ts`)
  - Bidirectional conversion between markdown and JSON
  - Backup creation and conflict resolution
  - Format comparison and synchronization detection

### Phase 2: TaskBackend Implementation 🔄 IN PROGRESS
- [ ] **Create JsonFileTaskBackend** (`src/domain/tasks/jsonFileTaskBackend.ts`)
  - Implement TaskBackend interface using DatabaseStorage
  - Handle task CRUD operations via the JSON storage
  - Maintain compatibility with existing task operations
- [ ] **Fix linter errors** in migration utilities
  - Replace `log.info` with appropriate logger methods
  - Fix TypeScript type issues with regex matches
  - Resolve module import issues

### Phase 3: Integration and Testing ✅ LINTER ISSUES RESOLVED
- [x] **Fix remaining linter issues**
  - ✅ **OS module import**: Replaced with cross-platform home directory function using process.env
  - ✅ **Bun test API compatibility**: Fixed test imports, methods, and array access patterns
  - ✅ **Session workspace compatibility**: All imports and operations now work correctly in session context
- [ ] **Update TaskService** to support JsonFileTaskBackend
  - Add backend registration and selection
  - Ensure seamless switching between backends
- [ ] **Create comprehensive tests**
  - ✅ Basic JsonFileTaskBackend test suite (12 tests passing)
  - Unit tests for DatabaseStorage and JsonFileStorage  
  - Integration tests for JsonFileTaskBackend
  - Migration utility tests
- [ ] **Update CLI commands** to work with new backend
  - Test all existing task commands
  - Ensure no breaking changes

### Phase 4: Documentation and Migration
- [ ] **Create migration guide** for existing users
- [ ] **Update documentation** to reflect new backend options
- [ ] **Add CLI commands** for manual migration if needed

## Task Analysis Notes

### ✅ **Architecture Completed:**
The DatabaseStorage abstraction layer provides a clean separation between business logic and storage implementation. Key benefits:

1. **Type Safety**: Generic interfaces ensure compile-time type checking
2. **Future-Proof**: Easy to add SQLite or other backends later
3. **Error Handling**: Comprehensive error types and recovery mechanisms
4. **Performance**: Atomic operations and efficient JSON serialization

### ✅ **Migration Strategy Implemented:**
The migration utilities support:
- Converting existing `tasks.md` to centralized JSON database
- Backup creation for safety
- Bidirectional conversion for rollback scenarios
- Format comparison to detect synchronization issues

### 🔄 **Current Progress:**
- Storage layer: 100% complete
- Migration utilities: 100% complete ✅
- JsonFileTaskBackend: 100% complete ✅
- Testing: Basic test suite complete ✅ (12 tests passing)
- Integration: 0% complete
- Linter compatibility: 100% resolved ✅

### �� **Next Steps:**
1. ✅ Fix OS module import and bun:test compatibility issues - COMPLETED
2. Integrate JsonFileTaskBackend with existing TaskService
3. Create comprehensive tests to verify functionality  
4. Update CLI commands and documentation

## Acceptance Criteria

- [x] DatabaseStorage interface created with generic type support
- [x] JsonFileStorage implementation with proper error handling
- [x] Migration utilities for markdown ↔ JSON conversion
- [ ] JsonFileTaskBackend implementing existing TaskBackend interface
- [ ] All existing task operations work with new backend
- [ ] Tasks synchronized across multiple sessions/workspaces
- [ ] Migration path from existing tasks.md files
- [ ] Comprehensive test coverage
- [ ] Documentation updated

## Dependencies

- Existing TaskBackend interface
- TaskData and TaskState types
- Minsky session management system
- File system operations (fs/promises)

## Notes

- The JSON database will be stored at `~/.local/state/minsky/tasks.json` by default
- Migration utilities create backups before any destructive operations
- The design supports transparent upgrades to SQLite or other databases
- All changes maintain backwards compatibility with existing CLI commands
