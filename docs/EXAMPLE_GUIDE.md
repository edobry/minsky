# Testing Examples in Minsky

This document provides practical examples of how to write tests in the Minsky project, covering different scenarios and approaches.

## Table of Contents

1. [Basic Test Examples](#basic-test-examples)
2. [Mocking Examples](#mocking-examples)
3. [Compatibility Layer Examples](#compatibility-layer-examples)
4. [Dependency Injection Examples](#dependency-injection-examples)
5. [Integration Test Examples](#integration-test-examples)
6. [Advanced Testing Patterns](#advanced-testing-patterns)

## Basic Test Examples

### Testing a Pure Function

```typescript
// src/utils/format.ts
export function formatTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toUpperCase();
}

// src/utils/__tests__/format.test.ts
import { describe, test, expect } from "bun:test";
import { formatTitle } from "../format";

describe("formatTitle", () => {
  test("should convert string to uppercase", () => {
    expect(formatTitle("hello world")).toBe("HELLO WORLD");
  });

  test("should trim whitespace", () => {
    expect(formatTitle("  hello  world  ")).toBe("HELLO WORLD");
  });

  test("should normalize multiple spaces", () => {
    expect(formatTitle("hello    world")).toBe("HELLO WORLD");
  });
});
```

### Testing a Component with State

```typescript
// src/components/counter.ts
export function createCounter(initialValue = 0) {
  let count = initialValue;
  
  return {
    increment() {
      count += 1;
      return count;
    },
    decrement() {
      count -= 1;
      return count;
    },
    reset() {
      count = initialValue;
      return count;
    },
    getValue() {
      return count;
    }
  };
}

// src/components/__tests__/counter.test.ts
import { describe, test, expect } from "bun:test";
import { createCounter } from "../counter";

describe("Counter", () => {
  test("should initialize with default value", () => {
    const counter = createCounter();
    expect(counter.getValue()).toBe(0);
  });
  
  test("should initialize with provided value", () => {
    const counter = createCounter(10);
    expect(counter.getValue()).toBe(10);
  });
  
  test("should increment counter", () => {
    const counter = createCounter(5);
    expect(counter.increment()).toBe(6);
    expect(counter.getValue()).toBe(6);
  });
  
  test("should decrement counter", () => {
    const counter = createCounter(5);
    expect(counter.decrement()).toBe(4);
    expect(counter.getValue()).toBe(4);
  });
  
  test("should reset counter", () => {
    const counter = createCounter(5);
    counter.increment();
    counter.increment();
    expect(counter.getValue()).toBe(7);
    
    expect(counter.reset()).toBe(5);
    expect(counter.getValue()).toBe(5);
  });
});
```

### Testing Asynchronous Code

```typescript
// src/services/data-service.ts
export function createDataService() {
  return {
    async fetchData(id: string): Promise<any> {
      // Simulating API call
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (id === "invalid") {
            reject(new Error("Invalid ID"));
          } else {
            resolve({ id, name: "Test Data", value: 42 });
          }
        }, 10);
      });
    }
  };
}

// src/services/__tests__/data-service.test.ts
import { describe, test, expect } from "bun:test";
import { createDataService } from "../data-service";

describe("DataService", () => {
  test("should fetch data successfully", async () => {
    const dataService = createDataService();
    const result = await dataService.fetchData("123");
    
    expect(result.id).toBe("123");
    expect(result.name).toBe("Test Data");
    expect(result.value).toBe(42);
  });
  
  test("should reject with error for invalid ID", async () => {
    const dataService = createDataService();
    
    try {
      await dataService.fetchData("invalid");
      // If we reach here, the test should fail
      expect(true).toBe(false);
    } catch (error) {
      expect(error.message).toBe("Invalid ID");
    }
  });
});
```

## Mocking Examples

### Basic Function Mocking

```typescript
// src/services/user-service.ts
import { logger } from "../utils/logger";
import { apiClient } from "../utils/api-client";

export async function getUserProfile(userId: string) {
  try {
    logger.info(`Fetching user profile for ${userId}`);
    return await apiClient.get(`/users/${userId}`);
  } catch (error) {
    logger.error(`Failed to fetch user profile: ${error.message}`);
    throw error;
  }
}

// src/services/__tests__/user-service.test.ts
import { describe, test, expect } from "bun:test";
import { createMock } from "../../utils/test-utils/mocking";
import { mockModule } from "../../utils/test-utils/mocking";
import { setupTestMocks } from "../../utils/test-utils/mocking";

// Set up mock tracking
setupTestMocks();

// Mock dependencies before importing the module
mockModule("../utils/logger", () => ({
  info: createMock(),
  error: createMock()
}));

mockModule("../utils/api-client", () => ({
  get: createMock((url) => Promise.resolve({ id: url.split("/")[2], name: "Test User" }))
}));

// Import after mocking
import { getUserProfile } from "../user-service";
import { logger } from "../utils/logger";
import { apiClient } from "../utils/api-client";

describe("getUserProfile", () => {
  test("should fetch and return user profile", async () => {
    const userId = "123";
    const result = await getUserProfile(userId);
    
    expect(logger.info).toHaveBeenCalledWith("Fetching user profile for 123");
    expect(apiClient.get).toHaveBeenCalledWith("/users/123");
    expect(result).toEqual({ id: "123", name: "Test User" });
  });
  
  test("should handle errors properly", async () => {
    const error = new Error("Network error");
    (apiClient.get as any).mockImplementationOnce(() => Promise.reject(error));
    
    try {
      await getUserProfile("456");
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect(e).toBe(error);
      expect(logger.error).toHaveBeenCalledWith("Failed to fetch user profile: Network error");
    }
  });
});
```

### Using Mock Objects

```typescript
// src/services/task-service.ts
export interface TaskRepository {
  findById(id: string): Promise<any>;
  save(task: any): Promise<any>;
  delete(id: string): Promise<boolean>;
}

export function createTaskService(taskRepository: TaskRepository) {
  return {
    async getTask(id: string) {
      return await taskRepository.findById(id);
    },
    
    async completeTask(id: string) {
      const task = await taskRepository.findById(id);
      if (!task) {
        throw new Error(`Task not found: ${id}`);
      }
      
      task.completed = true;
      task.completedAt = new Date();
      
      return await taskRepository.save(task);
    }
  };
}

// src/services/__tests__/task-service.test.ts
import { describe, test, expect } from "bun:test";
import { createMock, createMockObject } from "../../utils/test-utils/mocking";
import { setupTestMocks } from "../../utils/test-utils/mocking";
import { createTaskService, TaskRepository } from "../task-service";

// Set up mock tracking
setupTestMocks();

describe("TaskService", () => {
  test("should get task by ID", async () => {
    // Create mock repository
    const mockRepo = createMockObject<TaskRepository>(["findById", "save", "delete"]);
    
    // Configure mock behavior
    mockRepo.findById.mockImplementation((id) => Promise.resolve({
      id,
      title: "Test Task",
      completed: false
    }));
    
    // Create service with mocked repo
    const taskService = createTaskService(mockRepo);
    
    // Execute test
    const task = await taskService.getTask("task-123");
    
    // Verify results
    expect(mockRepo.findById).toHaveBeenCalledWith("task-123");
    expect(task).toEqual({
      id: "task-123",
      title: "Test Task",
      completed: false
    });
  });
  
  test("should complete a task", async () => {
    // Create mock repository
    const mockRepo = createMockObject<TaskRepository>(["findById", "save", "delete"]);
    
    // Configure mock behavior
    const task = {
      id: "task-123",
      title: "Test Task",
      completed: false
    };
    
    mockRepo.findById.mockImplementation(() => Promise.resolve({ ...task }));
    mockRepo.save.mockImplementation((updatedTask) => Promise.resolve(updatedTask));
    
    // Create service with mocked repo
    const taskService = createTaskService(mockRepo);
    
    // Execute test
    const result = await taskService.completeTask("task-123");
    
    // Verify results
    expect(mockRepo.findById).toHaveBeenCalledWith("task-123");
    expect(mockRepo.save).toHaveBeenCalled();
    expect(result.completed).toBe(true);
    expect(result.completedAt).toBeInstanceOf(Date);
  });
  
  test("should throw error when completing non-existent task", async () => {
    // Create mock repository
    const mockRepo = createMockObject<TaskRepository>(["findById", "save", "delete"]);
    
    // Configure mock behavior - task not found
    mockRepo.findById.mockImplementation(() => Promise.resolve(null));
    
    // Create service with mocked repo
    const taskService = createTaskService(mockRepo);
    
    // Execute test
    try {
      await taskService.completeTask("non-existent");
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error.message).toBe("Task not found: non-existent");
    }
  });
});
```

## Compatibility Layer Examples

### Using Jest-like Mocks

```typescript
// src/services/__tests__/user-service-compat.test.ts
import { describe, test, expect } from "bun:test";
import { setupTestCompat, createCompatMock, jest } from "../../utils/test-utils/compatibility";

// Set up compatibility layer
setupTestCompat();

// Mock dependencies before importing
jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn()
}));

jest.mock("../utils/api-client", () => ({
  get: jest.fn((url) => Promise.resolve({ id: url.split("/")[2], name: "Test User" }))
}));

// Import after mocking
import { getUserProfile } from "../user-service";
import { logger } from "../utils/logger";
import { apiClient } from "../utils/api-client";

describe("getUserProfile with Compatibility Layer", () => {
  test("should fetch and return user profile", async () => {
    const userId = "123";
    const result = await getUserProfile(userId);
    
    expect(logger.info).toHaveBeenCalledWith("Fetching user profile for 123");
    expect(apiClient.get).toHaveBeenCalledWith("/users/123");
    expect(result).toEqual({ id: "123", name: "Test User" });
  });
  
  test("should handle errors properly", async () => {
    const error = new Error("Network error");
    (apiClient.get as any).mockImplementationOnce(() => Promise.reject(error));
    
    try {
      await getUserProfile("456");
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect(e).toBe(error);
      expect(logger.error).toHaveBeenCalledWith("Failed to fetch user profile: Network error");
    }
  });
  
  // Reset mocks after tests
  afterEach(() => {
    jest.clearAllMocks();
  });
});
```

### Using Asymmetric Matchers

```typescript
// src/services/__tests__/data-formatter.test.ts
import { describe, test, expect } from "bun:test";
import { setupTestCompat, asymmetricMatchers } from "../../utils/test-utils/compatibility";

// Set up compatibility layer
setupTestCompat();

// Import after setup
import { formatData } from "../data-formatter";

describe("DataFormatter with Compatibility Layer", () => {
  test("should format data with expected structure", () => {
    const rawData = {
      id: 123,
      userId: "user-456",
      timestamp: "2023-04-20T12:34:56Z",
      items: [
        { id: 1, name: "Item 1" },
        { id: 2, name: "Item 2" }
      ]
    };
    
    const result = formatData(rawData);
    
    // Using asymmetric matchers for flexible assertions
    expect(result).toEqual({
      id: asymmetricMatchers.any(String),
      user: asymmetricMatchers.objectContaining({ id: "user-456" }),
      processedAt: asymmetricMatchers.any(Date),
      items: asymmetricMatchers.arrayContaining([
        asymmetricMatchers.objectContaining({ name: "Item 1" })
      ]),
      meta: asymmetricMatchers.objectContaining({
        itemCount: 2,
        source: asymmetricMatchers.stringContaining("API")
      })
    });
  });
});
```

## Dependency Injection Examples

### Factory Function Pattern

```typescript
// src/services/notification-service.ts
export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface EmailProvider {
  sendEmail(to: string, subject: string, body: string): Promise<boolean>;
}

export function createNotificationService(deps: {
  logger: Logger;
  emailProvider: EmailProvider;
}) {
  return {
    async sendNotification(userId: string, message: string): Promise<boolean> {
      try {
        deps.logger.info(`Sending notification to ${userId}: ${message}`);
        const emailSent = await deps.emailProvider.sendEmail(
          `user-${userId}@example.com`,
          "New Notification",
          message
        );
        
        if (emailSent) {
          deps.logger.info(`Notification sent successfully to ${userId}`);
          return true;
        } else {
          deps.logger.error(`Failed to send notification to ${userId}`);
          return false;
        }
      } catch (error) {
        deps.logger.error(`Error sending notification: ${error.message}`);
        return false;
      }
    }
  };
}

// src/services/__tests__/notification-service.test.ts
import { describe, test, expect } from "bun:test";
import { createMock } from "../../utils/test-utils/mocking";
import { setupTestMocks } from "../../utils/test-utils/mocking";
import { createNotificationService } from "../notification-service";

// Set up mock tracking
setupTestMocks();

describe("NotificationService", () => {
  test("should send notification successfully", async () => {
    // Create mock dependencies
    const mockLogger = {
      info: createMock(),
      error: createMock()
    };
    
    const mockEmailProvider = {
      sendEmail: createMock(() => Promise.resolve(true))
    };
    
    // Create service with mocked dependencies
    const notificationService = createNotificationService({
      logger: mockLogger,
      emailProvider: mockEmailProvider
    });
    
    // Execute test
    const result = await notificationService.sendNotification("123", "Test message");
    
    // Verify results
    expect(result).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith("Sending notification to 123: Test message");
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledWith(
      "user-123@example.com",
      "New Notification",
      "Test message"
    );
    expect(mockLogger.info).toHaveBeenCalledWith("Notification sent successfully to 123");
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
  
  test("should handle failed email sending", async () => {
    // Create mock dependencies
    const mockLogger = {
      info: createMock(),
      error: createMock()
    };
    
    const mockEmailProvider = {
      sendEmail: createMock(() => Promise.resolve(false))
    };
    
    // Create service with mocked dependencies
    const notificationService = createNotificationService({
      logger: mockLogger,
      emailProvider: mockEmailProvider
    });
    
    // Execute test
    const result = await notificationService.sendNotification("123", "Test message");
    
    // Verify results
    expect(result).toBe(false);
    expect(mockLogger.info).toHaveBeenCalledWith("Sending notification to 123: Test message");
    expect(mockEmailProvider.sendEmail).toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith("Failed to send notification to 123");
  });
  
  test("should handle errors during email sending", async () => {
    // Create mock dependencies
    const mockLogger = {
      info: createMock(),
      error: createMock()
    };
    
    const error = new Error("Email service unavailable");
    const mockEmailProvider = {
      sendEmail: createMock(() => Promise.reject(error))
    };
    
    // Create service with mocked dependencies
    const notificationService = createNotificationService({
      logger: mockLogger,
      emailProvider: mockEmailProvider
    });
    
    // Execute test
    const result = await notificationService.sendNotification("123", "Test message");
    
    // Verify results
    expect(result).toBe(false);
    expect(mockEmailProvider.sendEmail).toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith("Error sending notification: Email service unavailable");
  });
});
```

### Using Test Dependency Helpers

```typescript
// src/domain/task-handler.ts
import { Dependencies } from "../types/dependencies";

export function createTaskHandler(deps: Dependencies) {
  return {
    async createTask(title: string, description: string) {
      const taskId = await deps.taskService.createTask({
        title,
        description,
        status: "TODO"
      });
      
      await deps.sessionService.attachTaskToSession(deps.session.id, taskId);
      
      return taskId;
    }
  };
}

// src/domain/__tests__/task-handler.test.ts
import { describe, test, expect } from "bun:test";
import { createTestDeps } from "../../utils/test-utils/dependencies";
import { createMock } from "../../utils/test-utils/mocking";
import { setupTestMocks } from "../../utils/test-utils/mocking";
import { createTaskHandler } from "../task-handler";

// Set up mock tracking
setupTestMocks();

describe("TaskHandler", () => {
  test("should create a task and attach it to session", async () => {
    // Create test dependencies with overrides
    const deps = createTestDeps({
      session: { id: "session-123" },
      taskService: {
        createTask: createMock(() => Promise.resolve("task-456"))
      },
      sessionService: {
        attachTaskToSession: createMock(() => Promise.resolve(true))
      }
    });
    
    // Create handler with test dependencies
    const taskHandler = createTaskHandler(deps);
    
    // Execute test
    const taskId = await taskHandler.createTask("Test Task", "Test description");
    
    // Verify results
    expect(taskId).toBe("task-456");
    expect(deps.taskService.createTask).toHaveBeenCalledWith({
      title: "Test Task",
      description: "Test description",
      status: "TODO"
    });
    expect(deps.sessionService.attachTaskToSession).toHaveBeenCalledWith(
      "session-123",
      "task-456"
    );
  });
});
```

## Integration Test Examples

### Testing Command Execution

```typescript
// src/adapters/__tests__/integration/cli-command.test.ts
import { describe, test, expect } from "bun:test";
import { setupTestMocks } from "../../../utils/test-utils/mocking";
import { createMock } from "../../../utils/test-utils/mocking";
import { createTestDeps } from "../../../utils/test-utils/dependencies";
import { runCommand } from "../../cli/command-runner";

// Set up mock tracking
setupTestMocks();

describe("CLI Command Integration", () => {
  test("should execute task create command", async () => {
    // Set up dependencies with mock implementations
    const deps = createTestDeps({
      taskService: {
        createTask: createMock(() => Promise.resolve("task-123")),
        getTask: createMock(() => Promise.resolve({
          id: "task-123",
          title: "New Task",
          status: "TODO"
        }))
      },
      logger: {
        info: createMock(),
        error: createMock()
      }
    });
    
    // Execute command
    const result = await runCommand(
      ["task", "create", "--title", "New Task", "--description", "Task description"],
      deps
    );
    
    // Verify integration results
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ taskId: "task-123" });
    expect(deps.taskService.createTask).toHaveBeenCalledWith({
      title: "New Task",
      description: "Task description",
      status: "TODO"
    });
    expect(deps.logger.info).toHaveBeenCalledWith("Task created: task-123");
  });
  
  test("should handle errors in command execution", async () => {
    // Set up dependencies with mock implementations that fail
    const error = new Error("Task creation failed");
    const deps = createTestDeps({
      taskService: {
        createTask: createMock(() => Promise.reject(error))
      },
      logger: {
        info: createMock(),
        error: createMock()
      }
    });
    
    // Execute command
    const result = await runCommand(
      ["task", "create", "--title", "New Task"],
      deps
    );
    
    // Verify error handling
    expect(result.success).toBe(false);
    expect(result.error).toBe(error);
    expect(deps.logger.error).toHaveBeenCalledWith("Failed to create task: Task creation failed");
  });
});
```

## Advanced Testing Patterns

### Using Test Fixtures

```typescript
// src/utils/test-utils/fixtures.ts
export function createUserFixture(overrides = {}) {
  return {
    id: "user-123",
    name: "Test User",
    email: "test@example.com",
    roles: ["user"],
    createdAt: new Date("2023-01-01T00:00:00.000Z"),
    ...overrides
  };
}

export function createTaskFixture(overrides = {}) {
  return {
    id: "task-456",
    title: "Test Task",
    description: "Test description",
    status: "TODO",
    createdAt: new Date("2023-01-01T00:00:00.000Z"),
    createdBy: "user-123",
    ...overrides
  };
}

export function createSessionFixture(overrides = {}) {
  return {
    id: "session-789",
    name: "Test Session",
    startedAt: new Date("2023-01-01T00:00:00.000Z"),
    user: createUserFixture(),
    tasks: [createTaskFixture()],
    ...overrides
  };
}

// src/domain/__tests__/session-manager.test.ts
import { describe, test, expect } from "bun:test";
import { setupTestMocks } from "../../utils/test-utils/mocking";
import { createMock } from "../../utils/test-utils/mocking";
import { createSessionFixture, createTaskFixture } from "../../utils/test-utils/fixtures";
import { createSessionManager } from "../session-manager";

// Set up mock tracking
setupTestMocks();

describe("SessionManager", () => {
  test("should add task to session", async () => {
    // Create fixtures
    const session = createSessionFixture();
    const newTask = createTaskFixture({ id: "task-new", title: "New Task" });
    
    // Create mocks
    const sessionRepo = {
      findById: createMock(() => Promise.resolve({ ...session })),
      save: createMock((updatedSession) => Promise.resolve(updatedSession))
    };
    
    const taskRepo = {
      findById: createMock(() => Promise.resolve({ ...newTask }))
    };
    
    // Create service under test
    const sessionManager = createSessionManager({ sessionRepo, taskRepo });
    
    // Execute test
    const result = await sessionManager.addTaskToSession(session.id, newTask.id);
    
    // Verify results
    expect(result.success).toBe(true);
    expect(sessionRepo.findById).toHaveBeenCalledWith(session.id);
    expect(taskRepo.findById).toHaveBeenCalledWith(newTask.id);
    
    // Verify the task was added to the session
    const savedSession = sessionRepo.save.mock.calls[0][0];
    expect(savedSession.tasks.length).toBe(2);
    expect(savedSession.tasks[1].id).toBe("task-new");
  });
});
```

### Testing with Contexts

```typescript
// src/domain/__tests__/task-workflow.test.ts
import { describe, test, expect } from "bun:test";
import { setupTestMocks } from "../../utils/test-utils/mocking";
import { createMock } from "../../utils/test-utils/mocking";
import { createUserFixture, createTaskFixture } from "../../utils/test-utils/fixtures";
import { createTaskWorkflow } from "../task-workflow";

// Set up mock tracking
setupTestMocks();

// Define test context type
interface TaskTestContext {
  taskRepo: any;
  userRepo: any;
  notificationService: any;
  workflow: any;
  testTask: any;
  testUser: any;
}

describe("TaskWorkflow", () => {
  // Create test context
  const createContext = (): TaskTestContext => {
    const testTask = createTaskFixture();
    const testUser = createUserFixture();
    
    const taskRepo = {
      findById: createMock(() => Promise.resolve({ ...testTask })),
      save: createMock((task) => Promise.resolve(task))
    };
    
    const userRepo = {
      findById: createMock(() => Promise.resolve({ ...testUser }))
    };
    
    const notificationService = {
      sendNotification: createMock(() => Promise.resolve(true))
    };
    
    const workflow = createTaskWorkflow({
      taskRepo,
      userRepo,
      notificationService
    });
    
    return {
      taskRepo,
      userRepo,
      notificationService,
      workflow,
      testTask,
      testUser
    };
  };
  
  test("should transition task from TODO to IN-PROGRESS", async () => {
    // Create test context
    const ctx = createContext();
    
    // Execute test
    const result = await ctx.workflow.startTask(ctx.testTask.id, ctx.testUser.id);
    
    // Verify results
    expect(result.success).toBe(true);
    expect(ctx.taskRepo.findById).toHaveBeenCalledWith(ctx.testTask.id);
    expect(ctx.userRepo.findById).toHaveBeenCalledWith(ctx.testUser.id);
    
    // Verify task was updated
    const updatedTask = ctx.taskRepo.save.mock.calls[0][0];
    expect(updatedTask.status).toBe("IN-PROGRESS");
    expect(updatedTask.assignedTo).toBe(ctx.testUser.id);
    expect(updatedTask.startedAt).toBeInstanceOf(Date);
    
    // Verify notification was sent
    expect(ctx.notificationService.sendNotification).toHaveBeenCalledWith(
      ctx.testUser.id,
      expect.stringContaining("started")
    );
  });
  
  test("should complete a task", async () => {
    // Create test context with a task already in progress
    const ctx = createContext();
    ctx.testTask.status = "IN-PROGRESS";
    ctx.testTask.assignedTo = ctx.testUser.id;
    
    // Execute test
    const result = await ctx.workflow.completeTask(ctx.testTask.id);
    
    // Verify results
    expect(result.success).toBe(true);
    
    // Verify task was updated
    const updatedTask = ctx.taskRepo.save.mock.calls[0][0];
    expect(updatedTask.status).toBe("DONE");
    expect(updatedTask.completedAt).toBeInstanceOf(Date);
    
    // Verify notification was sent
    expect(ctx.notificationService.sendNotification).toHaveBeenCalledWith(
      ctx.testUser.id,
      expect.stringContaining("completed")
    );
  });
}); 
