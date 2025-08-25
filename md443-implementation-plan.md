# MD#443 Implementation Plan: Multi-Backend TaskService Integration

## Executive Summary

The MultiBackendTaskService is **partially implemented and tested**, but has a **critical interface compatibility issue** that prevents it from being a drop-in replacement for the current TaskService. This is primarily an **interface alignment task** followed by systematic integration.

## Current State Analysis

### ✅ What's Working

- **Core Implementation**: MultiBackendTaskService class exists and works
- **Test Coverage**: 7/7 unit tests + 6/6 integration tests passing
- **Routing Logic**: Qualified ID parsing (md#123 → markdown backend) implemented

### 🚨 **CRITICAL ISSUE: Interface Incompatibility**

The current `MultiBackendTaskService` interface is **incompatible** with what the codebase expects from a task service.

**Expected Interface** (defined in `TaskServiceInterface`):

```typescript
interface TaskServiceInterface {
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  getTaskStatus(id: string): Promise<string | undefined>;
  setTaskStatus(id: string, status: string): Promise<void>;
  getWorkspacePath(): string;
  createTask(specPath: string, options?: CreateTaskOptions): Promise<Task>;
  createTaskFromTitleAndSpec(title: string, spec: string): Promise<Task>;
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>;
  getBackendForTask(taskId: string): Promise<string>;
}
```

**Current MultiBackendTaskService Interface**:

```typescript
interface MultiBackendTaskService {
  registerBackend(backend: TaskBackend): void; // ⚠️ NEW - not expected
  listBackends(): TaskBackend[]; // ⚠️ NEW - not expected
  createTask(spec: TaskSpec, backendPrefix?: string); // ❌ WRONG SIGNATURE
  getTask(taskId: string): Promise<Task | null>; // ✅ COMPATIBLE
  listAllTasks(): Promise<Task[]>; // ❌ WRONG NAME (should be listTasks)
  updateTask(taskId: string, updates: Partial<Task>); // ⚠️ NOT EXPECTED
  deleteTask(taskId: string): Promise<void>; // ❌ WRONG RETURN TYPE (should return boolean)
  // ❌ MISSING: getTaskStatus, setTaskStatus, getWorkspacePath, createTaskFromTitleAndSpec, getBackendForTask
}
```

### ⚠️ What Needs Work

1. **Interface Compatibility**: MultiBackendTaskService must implement `TaskServiceInterface`
2. **Missing Methods**: 5+ critical methods are completely missing
3. **Wrong Signatures**: Several methods have incompatible signatures
4. **Integration**: 53+ files need to be updated after interface is fixed

## Implementation Phases

## PHASE 1: Interface Compatibility (CRITICAL)

### Goal

Make MultiBackendTaskService implement `TaskServiceInterface` for drop-in replacement

### Required Implementation Changes

#### 1.1 Fix MultiBackendTaskService Interface

The `MultiBackendTaskService` interface must be updated to implement `TaskServiceInterface`:

```typescript
// src/domain/tasks/multi-backend-service.ts
export interface MultiBackendTaskService extends TaskServiceInterface {
  // Keep multi-backend specific methods
  registerBackend(backend: TaskBackend): void;
  listBackends(): TaskBackend[];

  // Fix existing method signatures to match TaskServiceInterface
  listTasks(options?: TaskListOptions): Promise<Task[]>; // Fixed: was listAllTasks()
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>; // Fixed: return boolean
  createTask(specPath: string, options?: CreateTaskOptions): Promise<Task>; // Fixed: signature

  // Add missing methods from TaskServiceInterface
  getTaskStatus(id: string): Promise<string | undefined>;
  setTaskStatus(id: string, status: string): Promise<void>;
  getWorkspacePath(): string;
  createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task>;
  getBackendForTask(taskId: string): Promise<string>;
}
```

#### 1.2 Fix MultiBackendTaskServiceImpl Class

The implementation class needs to implement all missing methods:

```typescript
export class MultiBackendTaskServiceImpl implements MultiBackendTaskService {
  private readonly backends: TaskBackend[] = [];
  private workspacePath: string;

  constructor(options: { workspacePath: string }) {
    this.workspacePath = options.workspacePath;
  }

  // ---- EXISTING METHODS (keep routing logic) ----
  registerBackend(backend: TaskBackend): void {
    /* existing */
  }
  listBackends(): TaskBackend[] {
    /* existing */
  }
  getTask(taskId: string): Promise<Task | null> {
    /* existing with routing */
  }

  // ---- FIX EXISTING METHOD SIGNATURES ----
  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    // Rename from listAllTasks, keep multi-backend logic
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    // Fix return type from void to boolean
  }

  async createTask(specPath: string, options?: CreateTaskOptions): Promise<Task> {
    // Fix signature from (spec: TaskSpec, backendPrefix?: string)
  }

  // ---- ADD MISSING METHODS ----
  async getTaskStatus(id: string): Promise<string | undefined> {
    const backend = this.routeToBackend(id);
    return backend.getTaskStatus(id);
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    const backend = this.routeToBackend(id);
    return backend.setTaskStatus(id, status);
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    // Route to appropriate backend based on options or default
  }

  async getBackendForTask(taskId: string): Promise<string> {
    const prefix = this.parsePrefixFromId(taskId);
    return prefix || "default";
  }
}
```

## PHASE 2: Drop-In Replacement Factory

### Goal

Create drop-in replacement factory that returns TaskServiceInterface-compatible service

### Tasks

#### 2.1 Create createMultiBackendTaskService Factory

```typescript
// src/domain/tasks/multi-backend-service.ts
export function createMultiBackendTaskService(
  options: TaskServiceOptions
): MultiBackendTaskService {
  const service = new MultiBackendTaskServiceImpl({ workspacePath: options.workspacePath });

  // Register all available backends with their prefixes
  service.registerBackend(
    createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: options.workspacePath,
      prefix: "md", // Add prefix to backend config
    })
  );

  service.registerBackend(
    createJsonFileTaskBackend({
      name: "json-file",
      workspacePath: options.workspacePath,
      prefix: "json",
    })
  );

  // Register other backends as available...

  return service;
}
```

#### 2.2 Replace createConfiguredTaskService Implementation

Make it return MultiBackendTaskService by default:

```typescript
export function createConfiguredTaskService(options: TaskServiceOptions): TaskServiceInterface {
  // Always return multi-backend service since it's compatible
  return createMultiBackendTaskService(options);
}
```

## PHASE 3: Backend Interface Alignment

### Goal

Add missing properties to existing backends so they work with multi-backend routing

### Required Backend Changes

Each backend needs to implement the multi-backend interface properties:

#### 3.1 MarkdownTaskBackend Updates

```typescript
// src/domain/tasks/markdownTaskBackend.ts
export class MarkdownTaskBackend implements TaskBackend {
  public readonly prefix = "md";

  validateLocalId(localId: string): boolean {
    return /^\d+$/.test(localId);
  }

  async exportTask(taskId: string): Promise<TaskExportData> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return {
      spec: { id: taskId, title: task.title, description: task.spec || "", status: task.status },
      metadata: { backend: "markdown" },
      backend: "markdown",
    };
  }

  async importTask(data: TaskExportData): Promise<Task> {
    return this.createTaskFromTitleAndSpec(data.spec.title, data.spec.description);
  }
}
```

#### 3.2 Other Backend Updates

Apply same pattern to:

- [ ] `JsonFileTaskBackend` (prefix: "json")
- [ ] `GitHubIssuesTaskBackend` (prefix: "gh")
- [ ] `DatabaseTaskBackend` (prefix: "db")

## PHASE 4: Transparent Rollout

### Goal

Once interface compatibility is achieved, the rollout becomes automatic since MultiBackendTaskService will be a drop-in replacement

### Key Insight: No File-by-File Updates Needed!

Because MultiBackendTaskService implements `TaskServiceInterface`, once `createConfiguredTaskService` returns it by default:

✅ **All 53+ files automatically get multi-backend functionality**  
✅ **No code changes needed in CLI commands, session operations, MCP adapters**  
✅ **Existing tests continue to work unchanged**  
✅ **Backward compatibility is maintained**

The beauty of this approach is that **interface compatibility eliminates the integration burden**.

### Rollout Strategy

#### Simple Two-Step Process

1. **Fix the interface** (Phase 1-3 above)
2. **Change the factory default** (one line change):

```typescript
// src/domain/tasks/taskService.ts
export function createConfiguredTaskService(options: TaskServiceOptions): TaskServiceInterface {
  // OLD: return new TaskService(options);
  return createMultiBackendTaskService(options); // NEW: Multi-backend by default
}
```

That's it! Every file that calls `createConfiguredTaskService()` now gets multi-backend routing automatically.

#### Verification Steps

- [ ] Run existing test suite - should pass unchanged
- [ ] Test qualified IDs in CLI: `minsky tasks get md#123`
- [ ] Test cross-backend operations
- [ ] Monitor performance (should be comparable)

#### Rollback Plan

Single line change to revert:

```typescript
export function createConfiguredTaskService(options: TaskServiceOptions) {
  return new TaskService(options); // Back to single-backend
}
```

## Quality Assurance

### Performance Considerations

- **Lazy backend loading**: Only initialize backends when first used
- **Route caching**: Cache backend routing decisions
- **Memory footprint**: Minimal increase (only routing metadata)

### Error Handling

- [ ] Clear error messages for unknown backend prefixes
- [ ] Graceful fallback when backends are unavailable
- [ ] Debug logging for routing decisions

## Success Metrics

### Technical Metrics

- [ ] **All tests pass**: Both existing and new multi-backend tests
- [ ] **Performance maintained**: No significant latency increase
- [ ] **Memory usage**: Minimal memory increase

### Functional Metrics

- [ ] **CLI commands work with qualified IDs**: `minsky tasks get md#123`
- [ ] **Cross-backend operations**: Task migration, collision detection
- [ ] **Error handling**: Clear messages for edge cases

### User Experience Metrics

- [ ] **Backward compatibility**: Existing workflows continue to work
- [ ] **Seamless transition**: Users don't notice the change
- [ ] **New capabilities**: Qualified ID routing works transparently

## Implementation Approach Summary

This implementation plan focuses on **interface compatibility first**, which dramatically simplifies the rollout:

1. **PHASE 1**: Fix MultiBackendTaskService interface to implement TaskServiceInterface
2. **PHASE 2**: Create drop-in replacement factory
3. **PHASE 3**: Add multi-backend properties to existing backends
4. **PHASE 4**: Single line change to enable multi-backend by default

The key insight is that **proper interface design eliminates the integration complexity**. Instead of updating 53+ files individually, we make MultiBackendTaskService compatible with the expected interface, then change the factory default.

## Next Steps

1. **Start with interface compatibility**: Update MultiBackendTaskService to implement TaskServiceInterface
2. **Add missing methods**: Implement all methods the codebase expects
3. **Test thoroughly**: Ensure all existing tests pass with new implementation
4. **Enable gradually**: Change factory default when confident in stability

This transforms what could be a complex, risky migration into a **controlled, reversible interface upgrade**.
