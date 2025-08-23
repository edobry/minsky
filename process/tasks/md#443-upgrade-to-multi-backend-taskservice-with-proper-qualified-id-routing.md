# Upgrade to Multi-Backend TaskService with Proper Qualified ID Routing

Status: TODO
Priority: HIGH
Dependencies: md#439 (database backend implementation)

## Summary

Replace the current single-backend `TaskService` with the `MultiBackendTaskService` to enable proper qualified ID routing. When a user calls `getTask("md#123")`, it should automatically route to the markdown backend with `localId="123"`. This will enable true multi-backend coordination and deprecate the current limited single-backend architecture.

## Context

Currently, the `TaskService` only supports a single backend at a time (`this.currentBackend`), even though we have qualified task IDs like `md#123`, `gh#456`, `db#789`. The existing `MultiBackendTaskService` exists and **IS WORKING** (7/7 unit tests pass, 6/6 integration tests pass) but isn't integrated into the main codebase.

### Current Status (As of Analysis)

**✅ GOOD NEWS**: The MultiBackendTaskService implementation is more complete than initially described:

- **Tests are ALL PASSING**: 7/7 unit tests + 6/6 integration tests = 100% test success rate
- **Core routing logic works**: Qualified ID parsing and backend routing is implemented
- **Interface is defined**: Both `MultiBackendTaskBackend` and `MultiBackendTaskService` interfaces exist
- **Mock factories exist**: Comprehensive test infrastructure is in place

**⚠️ INTEGRATION NEEDED**: The main blockers are integration points, not implementation quality:

- **Service creation**: Need to replace `TaskService` with `MultiBackendTaskService` in ~53 files
- **Interface alignment**: Current `TaskBackend` interface differs from `MultiBackendTaskBackend` interface
- **Factory functions**: Need to update `createConfiguredTaskService` and similar functions

**🔗 Dependency Update**: md#439 compilation errors appear resolved (session start now works), making this task less blocked than originally expected.

**Current Problem:**

```typescript
// Current behavior - single backend only
const taskService = new TaskService({ backend: "markdown" });
await taskService.getTask("gh#456"); // ❌ Calls markdown backend, doesn't route to GitHub
```

**Desired Behavior:**

```typescript
// Multi-backend behavior - automatic routing
const taskService = new MultiBackendTaskService();
await taskService.getTask("md#123"); // ✅ Routes to markdown backend with localId="123"
await taskService.getTask("gh#456"); // ✅ Routes to GitHub backend with localId="456"
await taskService.getTask("db#789"); // ✅ Routes to database backend with localId="789"
```

## Requirements

### 1. **Qualified ID Routing Implementation**

- [ ] Replace `TaskService` usage with `MultiBackendTaskService` across codebase
- [ ] Implement automatic routing: `md#123` → markdown backend with `localId="123"`
- [ ] Support all qualified prefixes: `md#`, `gh#`, `db#`, `json#`
- [ ] Maintain fallback to default backend for unqualified IDs

### 2. **Backend Interface Alignment**

- [ ] All backends must implement the multi-backend interface:
  ```typescript
  interface TaskBackend {
    name: string;
    prefix: string; // "md", "gh", "db", "json"
    exportTask(localId: string): Promise<TaskExportData>;
    importTask(data: TaskExportData): Promise<Task>;
    validateLocalId(localId: string): boolean;
    // ... existing methods
  }
  ```

### 3. **Local ID Handling (CRITICAL)**

- [ ] **Backend Input**: Backends should ONLY receive the post-# portion
  - `getTask("md#123")` → `markdownBackend.getTask("123")`
  - `getTask("gh#456")` → `githubBackend.getTask("456")`
  - `getTask("db#789")` → `databaseBackend.getTask("789")`
- [ ] **Backend Output**: Backends should return qualified IDs in responses
  - `markdownBackend.getTask("123")` → `{ id: "md#123", title: "..." }`
- [ ] **Test Verification**: All tests must verify this local ID handling

### 4. **Export/Import Implementation**

- [ ] **MarkdownTaskBackend**: Implement `exportTask()` and `importTask()`
- [ ] **JsonFileTaskBackend**: Implement `exportTask()` and `importTask()`
- [ ] **GitHubIssuesTaskBackend**: Implement `exportTask()` and `importTask()`
- [ ] **DatabaseTaskBackend**: Implement `exportTask()` and `importTask()`

### 5. **Integration Points**

- [ ] **CLI adapters**: Update to use `MultiBackendTaskService`
- [ ] **MCP adapters**: Update to use `MultiBackendTaskService`
- [ ] **Task commands**: Update imports and service creation
- [ ] **Task similarity service**: Update to work with multi-backend

### 6. **Test Coverage**

- [ ] **Existing tests**: All current tests must pass with multi-backend service
- [ ] **Routing tests**: Verify qualified ID routing works correctly
- [ ] **Local ID tests**: Verify backends only receive post-# portion
- [ ] **Cross-backend tests**: Test migration and collision detection
- [ ] **Integration tests**: Full end-to-end multi-backend workflows

### 7. **Backward Compatibility**

- [ ] **CLI commands**: Existing commands should work without changes
- [ ] **Configuration**: Support both single-backend and multi-backend configs
- [ ] **Error handling**: Proper error messages for unknown backend prefixes

## Implementation Steps

### Phase 1: Backend Interface Updates

1. **Add multi-backend interface properties** to all existing backends:

   - Add `prefix` property (`"md"`, `"gh"`, `"db"`, `"json"`)
   - Implement `exportTask()` and `importTask()` methods
   - Implement `validateLocalId()` method

2. **Update local ID handling** in all backends:
   - Ensure backends expect and work with local IDs only (post-# portion)
   - Ensure backends return qualified IDs in response objects
   - Update all backend tests to verify this behavior

### Phase 2: Service Integration

3. **Replace TaskService with MultiBackendTaskService**:

   - Update service creation in CLI adapters
   - Update service creation in MCP adapters
   - Update imports throughout codebase

4. **Update routing configuration**:
   - Register all available backends in MultiBackendTaskService
   - Set appropriate default backend for unqualified IDs
   - Handle backend availability gracefully

### Phase 3: Testing and Validation

5. **Verify multi-backend tests** (STATUS: ✅ ALREADY PASSING):

   - ✅ multi-backend-system.test.ts: 7/7 tests passing
   - ✅ multi-backend-real-integration.test.ts: 6/6 tests passing
   - Add comprehensive routing tests for edge cases

6. **Integration testing**:
   - Test all CLI commands with qualified IDs
   - Test cross-backend operations (list, search, migrate)
   - Test error handling for unknown backends

### Phase 4: Documentation and Cleanup

7. **Update documentation**:

   - Document qualified ID routing behavior
   - Update CLI help text to mention multi-backend support
   - Add migration guide for users

8. **Deprecate old TaskService**:
   - Mark old TaskService as deprecated
   - Provide migration path
   - Plan removal timeline

## Expected Behavior Changes

### Before (Single Backend)

```bash
# Only shows tasks from configured backend
minsky tasks list --backend markdown

# Error if task is in different backend
minsky tasks get gh#456  # ❌ Fails if backend=markdown
```

### After (Multi Backend)

```bash
# Shows tasks from all backends
minsky tasks list

# Automatic routing to correct backend
minsky tasks get md#123  # ✅ Routes to markdown backend
minsky tasks get gh#456  # ✅ Routes to GitHub backend
minsky tasks get db#789  # ✅ Routes to database backend

# Cross-backend operations
minsky tasks migrate md#123 gh  # Move task between backends
minsky tasks collisions        # Detect ID conflicts
```

## Risk Mitigation

### **Interface Breaking Changes**

- **Risk**: Multi-backend interface differs from current TaskBackend interface
- **Mitigation**: Implement both interfaces during transition period

### **Local ID Handling**

- **Risk**: Backends might not handle local-only IDs correctly
- **Mitigation**: Comprehensive testing of ID handling in all backends

### **Performance Impact**

- **Risk**: Multiple backend operations might be slower
- **Mitigation**: Lazy loading and efficient routing implementation

### **Backward Compatibility**

- **Risk**: Existing code might break with new service
- **Mitigation**: Gradual rollout with fallback mechanisms

## Success Criteria

1. **✅ Qualified ID Routing**: `getTask("md#123")` automatically routes to markdown backend with `localId="123"`
2. **✅ All Tests Pass**: Both existing and new multi-backend tests pass
3. **✅ Local ID Handling**: Backends only receive post-# portion and return qualified IDs
4. **✅ Cross-Backend Operations**: Migration, collision detection, and unified listing work
5. **✅ CLI Compatibility**: All existing CLI commands work without changes
6. **✅ Performance**: No significant performance degradation
7. **✅ Error Handling**: Clear error messages for unknown backends and malformed IDs

## Testing Strategy

### Unit Tests

- Test qualified ID parsing and routing logic
- Test local ID extraction and validation
- Test backend registration and selection

### Integration Tests

- Test end-to-end qualified ID workflows
- Test cross-backend operations
- Test CLI command compatibility

### Migration Tests

- Test upgrading from single-backend to multi-backend
- Test data integrity during migration
- Test rollback scenarios

## Future Enhancements

This multi-backend foundation enables:

- **Cross-backend task migration** (`minsky tasks migrate md#123 gh`)
- **Unified task search** across all backends
- **Collision detection** for duplicate local IDs
- **Backend-specific features** (GitHub Issues integration, database queries)
- **Workspace-level backend policies** (e.g., new tasks → GitHub, internal tasks → database)

## Dependencies

- ✅ **md#439**: Database backend implementation resolved (session start working, tests passing)
- ⚠️ **Interface consolidation**: TaskBackend interface unification (minor alignment needed between interfaces)

## UPDATED IMPLEMENTATION PLAN (Based on Current Analysis)

Given the actual state where MultiBackendTaskService is working but not integrated, here's a more targeted approach:

### PHASE 1: Interface Alignment (PRIORITY 1)

**Problem**: Current `TaskBackend` interface ≠ `MultiBackendTaskBackend` interface

**Current TaskBackend interface:**

```typescript
interface TaskBackend {
  name: string;
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task>;
  // ... other methods but NO prefix, exportTask, importTask, validateLocalId
}
```

**MultiBackendTaskBackend interface:**

```typescript
interface MultiBackendTaskBackend {
  name: string;
  prefix: string; // ⚠️ MISSING from current backends
  exportTask(taskId: string): Promise<TaskExportData>; // ⚠️ MISSING
  importTask(data: TaskExportData): Promise<Task>; // ⚠️ MISSING
  validateLocalId(localId: string): boolean; // ⚠️ MISSING
  // ... different method signatures
}
```

**ACTION ITEMS:**

1. **Add missing properties to existing backends**: `prefix`, `exportTask`, `importTask`, `validateLocalId`
2. **Create adapter/bridge pattern**: Allow current backends to work with multi-backend service during transition
3. **Update method signatures**: Align parameter and return types

### PHASE 2: Service Factory Integration (PRIORITY 2)

**Problem**: ~53 files use `TaskService` or `createConfiguredTaskService` but need `MultiBackendTaskService`

**Current Pattern:**

```typescript
const taskService = await createConfiguredTaskService({ workspacePath: "/path" });
await taskService.getTask("md#123"); // ❌ Only routes to configured backend
```

**Target Pattern:**

```typescript
const taskService = await createMultiBackendTaskService({ workspacePath: "/path" });
await taskService.getTask("md#123"); // ✅ Routes to markdown backend automatically
```

**ACTION ITEMS:**

1. **Create `createMultiBackendTaskService` factory**: Similar API to `createConfiguredTaskService`
2. **Update high-impact integration points first**: CLI commands, MCP adapters, session operations
3. **Gradual replacement strategy**: Update services one by one with testing at each step

### PHASE 3: Backend Registration (PRIORITY 3)

**Problem**: MultiBackendTaskService needs all backends registered with proper prefixes

**ACTION ITEMS:**

1. **Configure backend registry**: Register markdown("md"), json("json"), github("gh"), database("db") backends
2. **Set routing defaults**: Handle unqualified IDs gracefully
3. **Error handling**: Clear messages for unknown prefixes

### PHASE 4: Verification (PRIORITY 4)

**Tests are already passing, but need:**

1. **End-to-end integration tests**: CLI commands with qualified IDs
2. **Cross-backend operation tests**: Migration, collision detection
3. **Performance verification**: Ensure no degradation from single-backend approach

## Notes

- The existing `MultiBackendTaskService` is 95% complete but needs integration work
- Current backends need minor updates to support the multi-backend interface
- This change enables true multi-backend workflows that users are already expecting based on qualified ID usage
