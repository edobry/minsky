import { mock } from "bun:test";
import type { Task } from "./types";
import type {
  TaskBackend,
  TaskSpec,
  TaskFilters,
  TaskExportData,
  TaskService,
} from "./multi-backend-service";
import { createTaskService } from "./multi-backend-service";

// Mock TaskBackend implementation for testing
export function createMockBackend(name: string, prefix: string): TaskBackend {
  return {
    name,
    prefix,

    // Core task operations (mocked by default)
    createTask: mock(async (spec: TaskSpec): Promise<Task> => {
      return {
        id: `${prefix}#mock-${Math.random().toString(36).substr(2, 9)}`,
        title: spec.title,
        status: spec.status || "TODO",
        description: spec.description,
        metadata: {},
      };
    }),

    getTask: mock(async (taskId: string): Promise<Task | null> => {
      return {
        id: `${prefix}#${taskId}`,
        title: `Mock Task from ${name}`,
        status: "TODO",
        metadata: {},
      };
    }),

    updateTask: mock(async (taskId: string, updates: Partial<Task>): Promise<Task> => {
      return {
        id: `${prefix}#${taskId}`,
        title: updates.title || `Updated Mock Task`,
        status: updates.status || "TODO",
        description: updates.description,
        metadata: updates.metadata || {},
      };
    }),

    deleteTask: mock(async (taskId: string): Promise<void> => {
      // Mock delete - no-op
    }),

    listTasks: mock(async (filters?: TaskFilters): Promise<Task[]> => {
      return [
        {
          id: `${prefix}#1`,
          title: `Mock Task 1 from ${name}`,
          status: "TODO",
          metadata: {},
        },
        {
          id: `${prefix}#2`,
          title: `Mock Task 2 from ${name}`,
          status: "IN_PROGRESS",
          metadata: {},
        },
      ];
    }),

    getTaskSpecPath: mock((taskId: string): string => {
      return `/mock/path/${prefix}/${taskId}.md`;
    }),

    supportsFeature: mock((feature: string): boolean => {
      return true; // Mock supports all features
    }),

    // Multi-backend specific methods
    exportTask: mock(async (taskId: string): Promise<TaskExportData> => {
      return {
        spec: {
          title: `Exported Task ${taskId}`,
          description: `Task exported from ${name} backend`,
          status: "TODO",
        },
        metadata: {
          originalBackend: prefix,
          exportedBy: name,
        },
        backend: prefix,
        exportedAt: new Date().toISOString(),
      };
    }),

    importTask: mock(async (data: TaskExportData): Promise<Task> => {
      const importedId = `import-${Math.random().toString(36).substr(2, 9)}`;
      return {
        id: `${prefix}#${importedId}`,
        title: data.spec.title,
        status: data.spec.status || "TODO",
        description: data.spec.description,
        metadata: {
          ...data.metadata,
          importedAt: new Date().toISOString(),
          importedTo: prefix,
        },
      };
    }),

    validateLocalId: mock((localId: string): boolean => {
      // Mock validation - accept any non-empty string
      return typeof localId === "string" && localId.length > 0;
    }),
  };
}

// Factory function that creates a TaskService with mocks
export function createMockTaskService(): TaskService {
  return createTaskService({ workspacePath: "/test/workspace" });
}

// Helper function to create a service with pre-registered mock backends
export function createTaskServiceWithMocks(): {
  service: TaskService;
  mdBackend: TaskBackend;
  ghBackend: TaskBackend;
  jsonBackend: TaskBackend;
} {
  const service = createTaskService({ workspacePath: "/test/workspace" });
  const mdBackend = createMockBackend("Markdown", "md");
  const ghBackend = createMockBackend("GitHub Issues", "gh");
  const jsonBackend = createMockBackend("JSON File", "json");

  service.registerBackend(mdBackend);
  service.registerBackend(ghBackend);
  service.registerBackend(jsonBackend);

  return { service, mdBackend, ghBackend, jsonBackend };
}

// Helper to create a specific backend configuration for testing
export function createBackendConfiguration(
  configs: Array<{ name: string; prefix: string }>
): TaskBackend[] {
  return configs.map((config) => createMockBackend(config.name, config.prefix));
}

// Mock data generators for testing
export const mockTaskSpecs = {
  simple: (): TaskSpec => ({
    title: "Simple Test Task",
    description: "A simple task for testing",
    status: "TODO",
  }),

  complex: (): TaskSpec => ({
    title: "Complex Test Task",
    description: "A complex task with metadata",
    status: "IN_PROGRESS",
    priority: "high",
    assignee: "test-user",
    tags: ["test", "complex"],
  }),

  minimal: (): TaskSpec => ({
    title: "Minimal Task",
  }),
};

export const mockTasks = {
  markdown: (id: string): Task => ({
    id: `md#${id}`,
    title: `Markdown Task ${id}`,
    status: "TODO",
    description: `A test task from markdown backend`,
    metadata: {
      createdAt: "2024-01-01T00:00:00Z",
      backend: "md",
    },
  }),

  github: (id: string): Task => ({
    id: `gh#${id}`,
    title: `GitHub Issue ${id}`,
    status: "OPEN",
    description: `A test issue from GitHub backend`,
    metadata: {
      createdAt: "2024-01-01T00:00:00Z",
      backend: "gh",
      issueNumber: parseInt(id),
    },
  }),

  json: (id: string): Task => ({
    id: `json#${id}`,
    title: `JSON Task ${id}`,
    status: "TODO",
    description: `A test task from JSON backend`,
    metadata: {
      createdAt: "2024-01-01T00:00:00Z",
      backend: "json",
    },
  }),
};
