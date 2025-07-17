# Centralized Service Mock Factories Usage Guide

This document demonstrates how to use the new centralized service mock factories to eliminate duplication in test files.

## Overview

The centralized service mock factories eliminate the need for creating duplicate mock implementations across test files. Instead of each test creating its own `createMockSessionProvider`, `createMockGitService`, or `createMockTaskService`, tests can now import these from the centralized utilities.

## Available Factory Functions

### `createMockSessionProvider(overrides?)`

Creates a comprehensive mock implementation of `SessionProviderInterface`.

**Basic Usage:**
```typescript
import { createMockSessionProvider } from "../utils/test-utils";

const mockSessionProvider = createMockSessionProvider();
// All interface methods are available with sensible defaults
```

**With Overrides:**
```typescript
const mockSessionProvider = createMockSessionProvider({
  getSession: () => Promise.resolve({
    session: "test-session",
    repoName: "test-repo",
    repoUrl: "https://github.com/test/repo",
    createdAt: "2023-01-01T00:00:00Z",
    taskId: "#123",
    branch: "main",
    repoPath: "/path/to/repo",
  }),
  listSessions: () => Promise.resolve([
    // ... session array
  ]),
});
```

### `createMockGitService(overrides?)`

Creates a comprehensive mock implementation of `GitServiceInterface`.

**Basic Usage:**
```typescript
import { createMockGitService } from "../utils/test-utils";

const mockGitService = createMockGitService();
// All interface methods are available with sensible defaults
```

**With Overrides:**
```typescript
const mockGitService = createMockGitService({
  clone: () => Promise.resolve({ workdir: "/custom/workdir", session: "custom-session" }),
  execInRepository: (workdir, command) => {
    if (command.includes("status")) {
      return Promise.resolve("clean");
    }
    return Promise.resolve("mock output");
  },
  getStatus: () => Promise.resolve({ 
    modified: ["file1.ts"], 
    untracked: [], 
    deleted: [] 
  }),
});
```

### `createMockTaskService(overrides?)`

Creates a comprehensive mock implementation of `TaskServiceInterface`.

**Basic Usage:**
```typescript
import { createMockTaskService } from "../utils/test-utils";

const mockTaskService = createMockTaskService();
// All interface methods are available with sensible defaults
```

**With Overrides:**
```typescript
const mockTaskService = createMockTaskService({
  listTasks: () => Promise.resolve([
    {
      id: "#001",
      title: "Test Task",
      status: "TODO",
      description: "Test task description",
      worklog: [],
    },
  ]),
  getTask: (id) => Promise.resolve({
    id,
    title: "Test Task",
    status: "TODO",
    description: "Test task description",
    worklog: [],
  }),
});
```

## Migration Examples

### Before (Duplicated Mock Creation)

```typescript
// In session-context-resolver.test.ts
const createMockSessionProvider = (sessions: any[] = []): SessionProviderInterface => {
  return {
    listSessions: createMock(() => Promise.resolve(sessions)),
    getSession: createMock((sessionName: string) => {
      const session = sessions.find((s: any) => s.session === sessionName);
      return Promise.resolve(session || null);
    }),
    // ... 6 more methods
  };
};

// In session-auto-detection-integration.test.ts
const createMockSessionProvider = (sessions: SessionRecord[] = []): SessionProviderInterface => {
  return {
    listSessions: () => Promise.resolve(sessions),
    getSession: (sessionName: string) => {
      const session = sessions.find((s: SessionRecord) => s.session === sessionName);
      return Promise.resolve(session || null);
    },
    // ... 6 more methods (duplicated)
  };
};
```

### After (Centralized Factory)

```typescript
// In session-context-resolver.test.ts
import { createMockSessionProvider } from "../utils/test-utils";

const mockSessionProvider = createMockSessionProvider({
  listSessions: () => Promise.resolve(sessions),
  getSession: (sessionName: string) => {
    const session = sessions.find((s: any) => s.session === sessionName);
    return Promise.resolve(session || null);
  },
});

// In session-auto-detection-integration.test.ts
import { createMockSessionProvider } from "../utils/test-utils";

const mockSessionProvider = createMockSessionProvider({
  listSessions: () => Promise.resolve(sessions),
  getSession: (sessionName: string) => {
    const session = sessions.find((s: SessionRecord) => s.session === sessionName);
    return Promise.resolve(session || null);
  },
});
```

## Best Practices

### 1. Use Centralized Factories as Base
Always start with the centralized factory and only override specific methods:

```typescript
// ✅ Good
const mockService = createMockGitService({
  clone: () => Promise.resolve({ workdir: "/custom", session: "test" }),
});

// ❌ Avoid - creates a new implementation from scratch
const mockService = createPartialMock<GitServiceInterface>({
  clone: () => Promise.resolve({ workdir: "/custom", session: "test" }),
  // ... need to implement all other methods
});
```

### 2. Override Only What You Need
Only override methods that are relevant to your specific test:

```typescript
// ✅ Good - only override what's needed for the test
const mockTaskService = createMockTaskService({
  getTask: () => Promise.resolve({ id: "#123", title: "Test", status: "TODO" }),
});

// ❌ Avoid - overriding everything unnecessarily
const mockTaskService = createMockTaskService({
  getTask: () => Promise.resolve({ id: "#123", title: "Test", status: "TODO" }),
  listTasks: () => Promise.resolve([]),
  setTaskStatus: () => Promise.resolve(),
  // ... unnecessary overrides
});
```

### 3. Use Type-Safe Overrides
Leverage TypeScript's type safety when creating overrides:

```typescript
const mockSessionProvider = createMockSessionProvider({
  getSession: (sessionName: string) => {
    // TypeScript will ensure you return the correct type
    return Promise.resolve({
      session: sessionName,
      repoName: "test-repo",
      repoUrl: "https://github.com/test/repo",
      createdAt: new Date().toISOString(),
      taskId: "#123",
      branch: "main",
      repoPath: "/path/to/repo",
    });
  },
});
```

### 4. Combine with Existing Utilities
Use these factories alongside existing test utilities:

```typescript
import { 
  createMockSessionProvider, 
  createMockGitService, 
  createTaskData,
  createSessionData 
} from "../utils/test-utils";

const mockSessionProvider = createMockSessionProvider({
  listSessions: () => Promise.resolve([
    createSessionData({ session: "test-session" }),
    createSessionData({ session: "another-session" }),
  ]),
});

const mockTaskService = createMockTaskService({
  listTasks: () => Promise.resolve([
    createTaskData({ id: "#001", title: "First Task" }),
    createTaskData({ id: "#002", title: "Second Task" }),
  ]),
});
```

## Benefits

1. **Eliminates Duplication**: No more copy-pasting mock implementations across test files
2. **Consistent Interface Coverage**: All centralized factories provide complete interface implementations
3. **Maintainable**: When interfaces change, only one location needs updates
4. **Type-Safe**: Full TypeScript support with proper type checking
5. **Developer Experience**: Easy to use with sensible defaults and override patterns

## Impact

This change eliminates **200+ lines of duplicated code** across:
- 5+ files with `createMockSessionProvider` duplications
- 8+ files with `createMockGitService` duplications
- 4+ files with `createMockTaskService` duplications

Interface changes now only require updates in one central location instead of multiple scattered test files. 
