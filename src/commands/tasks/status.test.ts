import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { createStatusCommand } from "./status";
import { TaskService, TASK_STATUS } from "../../domain/tasks";

// Manual mocks for tracking call history
interface CallRecord {
  args: any[];
}

class ManualMock {
  calls: CallRecord[] = [];

  constructor() {
    this.clear();
  }

  call(...args: any[]): void {
    this.calls.push({ args });
  }

  clear(): void {
    this.calls = [];
  }
}

// Create manual mocks for TaskService methods
const taskMocks = {
  setTaskStatus: new ManualMock(),
  getTaskStatus: new ManualMock(),
  getTask: new ManualMock(),
};

// Setup mocks for external dependencies
mock.module("../../domain/tasks", () => {
  return {
    TaskService: class MockTaskService {
      constructor() {}

      async getTaskStatus(id: string) {
        taskMocks.getTaskStatus.call(id);
        if (id === "#001") return "TODO";
        if (id === "#002") return "DONE";
        if (id === "#003") return "IN-PROGRESS";
        if (id === "#004") return "IN-REVIEW";
        return null;
      }

      async setTaskStatus(id: string, status: string) {
        taskMocks.setTaskStatus.call(id, status);
        return;
      }

      async getTask(id: string) {
        taskMocks.getTask.call(id);
        const normalizedId = id.startsWith("#") ? id : `#${id}`;
        if (["#001", "#002", "#003", "#004"].includes(normalizedId)) {
          return {
            id: normalizedId,
            title: `Task ${normalizedId}`,
            status: status || "TODO", // Use set status in return value
            description: `This is task ${normalizedId}`,
          };
        }
        return null;
      }
    },
    TASK_STATUS: {
      TODO: "TODO",
      DONE: "DONE",
      IN_PROGRESS: "IN-PROGRESS",
      IN_REVIEW: "IN-REVIEW",
    },
  };
});

// We need a separate reference to status for the mock to work correctly
let status = "";

// Fix the test for the first case
describe("Status Command - Set", () => {
  let consoleOutput: string[] = [];
  let errorOutput: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    consoleOutput = [];
    errorOutput = [];
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(" "));
    };
    console.error = (...args: any[]) => {
      errorOutput.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test("should set task status successfully", async () => {
    // Setup a task set mock that works correctly with the command
    mock.module("../../domain/tasks", () => {
      return {
        TaskService: class MockTaskService {
          constructor() {}

          async getTaskStatus(id: string) {
            return "TODO";
          }

          async setTaskStatus(id: string, newStatus: string) {
            status = newStatus; // Store the status for getTask to return
            return;
          }

          async getTask(id: string) {
            return {
              id: "#001",
              title: "Task #001",
              status: status, // Return the status from setTaskStatus
              description: "This is task #001",
            };
          }
        },
        TASK_STATUS: {
          TODO: "TODO",
          DONE: "DONE",
          IN_PROGRESS: "IN-PROGRESS",
          IN_REVIEW: "IN-REVIEW",
        },
      };
    });

    // Create command
    const statusCommand = createStatusCommand();

    // Set status to DONE
    status = "DONE";

    // Execute command
    await statusCommand.parseAsync(["node", "status", "set", "001", "DONE"]);

    // Verify output
    expect(consoleOutput.length).toBeGreaterThan(0);
    expect(consoleOutput[0]).toBe("Updated task #001 status to DONE");
  });

  test("should validate status and report error for invalid status", async () => {
    // Setup a task set mock that throws for invalid status
    let exitCalled = false;
    let exitCode: number | null = null;

    // Mock process.exit
    mock.module("../../utils/process", () => {
      return {
        exit: (code: number) => {
          exitCalled = true;
          exitCode = code;
          return undefined as never;
        },
      };
    });

    // Setup a mock that throws for invalid status
    mock.module("../../domain/tasks", () => {
      return {
        TaskService: class MockTaskService {
          constructor() {}

          async getTaskStatus(id: string) {
            return "TODO";
          }

          async setTaskStatus(id: string, newStatus: string) {
            if (newStatus === "INVALID-STATUS") {
              throw new Error("Invalid status: 'INVALID-STATUS'");
            }
            return;
          }

          async getTask(id: string) {
            return {
              id: "#001",
              title: "Task #001",
              status: "TODO",
              description: "This is task #001",
            };
          }
        },
        TASK_STATUS: {
          TODO: "TODO",
          DONE: "DONE",
          IN_PROGRESS: "IN-PROGRESS",
          IN_REVIEW: "IN-REVIEW",
        },
      };
    });

    // Create command
    const statusCommand = createStatusCommand();

    // Execute command with invalid status
    await statusCommand.parseAsync(["node", "status", "set", "001", "INVALID-STATUS"]);

    // Verify error output
    expect(errorOutput.length).toBeGreaterThan(0);
    expect(errorOutput[0]).toContain("Error:");
    expect(errorOutput[0]).toContain("Invalid status");

    // Verify exit code
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(1);
  });

  test("requires status parameter in command line", () => {
    // This test verifies that commander requires the status parameter

    // Create a test command to check the commander arguments
    const cmd = createStatusCommand();
    const setCmd = cmd.commands.find((c: Command) => c.name() === "set");

    if (!setCmd) {
      throw new Error("Could not find set command");
    }

    // Verify command has required arguments
    // Commander marks required arguments with the property ._required = true
    const commandArgs = (setCmd as any)._args;

    // Expect the status argument to exist
    const statusArg = commandArgs.find((arg: any) => arg.name() === "status");
    expect(statusArg).toBeDefined();

    // Expect the task-id argument to exist
    const taskIdArg = commandArgs.find((arg: any) => arg.name() === "task-id");
    expect(taskIdArg).toBeDefined();

    // Both arguments should be required
    expect(statusArg.required).toBe(true);
    expect(taskIdArg.required).toBe(true);
  });
});
