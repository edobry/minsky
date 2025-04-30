import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { createListCommand } from "./list";
import { TaskService, TASK_STATUS } from "../../domain/tasks";
import { resolveRepoPath } from "../../domain/repo-utils";
import { resolveWorkspacePath } from "../../domain/workspace";

// Sample task data
const sampleTasks = [
  { id: "#001", title: "Task 1", status: TASK_STATUS.TODO, description: "" },
  { id: "#002", title: "Task 2", status: TASK_STATUS.IN_PROGRESS, description: "" },
  { id: "#003", title: "Task 3", status: TASK_STATUS.IN_REVIEW, description: "" },
  { id: "#004", title: "Task 4", status: TASK_STATUS.DONE, description: "" },
  { id: "#005", title: "Task 5", status: TASK_STATUS.DONE, description: "" },
];

// Mock external modules
jest.mock("../../domain/repo-utils", () => ({
  resolveRepoPath: () => Promise.resolve("/mock/repo/path"),
}));

jest.mock("../../domain/workspace", () => ({
  resolveWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
}));

const mockListTasks = jest.fn((options) => {
  if (options?.status) {
    return Promise.resolve(sampleTasks.filter(task => task.status === options.status));
  }
  return Promise.resolve([...sampleTasks]);
});

jest.mock("../../domain/tasks", () => ({
  TaskService: jest.fn(() => ({
    listTasks: mockListTasks,
  })),
  TASK_STATUS: {
    TODO: "TODO",
    DONE: "DONE",
    IN_PROGRESS: "IN-PROGRESS",
    IN_REVIEW: "IN-REVIEW",
  },
}));

describe("tasks list command", () => {
  // Mock console.log to capture output
  const originalConsoleLog = console.log;
  let consoleOutput: string[] = [];
  
  beforeEach(() => {
    // Clear our captured console output
    consoleOutput = [];
    console.log = jest.fn((...args) => {
      consoleOutput.push(args.join(" "));
    });
    
    jest.clearAllMocks();
  });
  
  afterEach(() => {
    console.log = originalConsoleLog;
  });
  
  it("filters out DONE tasks by default", async () => {
    const command = createListCommand();
    
    // Execute the command action directly with empty options
    await command.action({});
    
    // Verify mockListTasks was called
    expect(mockListTasks).toHaveBeenCalled();
    
    // Verify only non-DONE tasks were included in the output
    const nonDoneTasks = sampleTasks.filter(task => task.status !== TASK_STATUS.DONE);
    expect(consoleOutput.length).toBeGreaterThan(1);
    expect(consoleOutput[0]).toEqual("Tasks:");
    
    nonDoneTasks.forEach((task) => {
      const outputLine = `- ${task.id}: ${task.title} [${task.status}]`;
      expect(consoleOutput.some(line => line === outputLine)).toBeTrue();
    });
    
    // Verify DONE tasks were NOT included in the output
    const doneTasks = sampleTasks.filter(task => task.status === TASK_STATUS.DONE);
    doneTasks.forEach((task) => {
      const outputLine = `- ${task.id}: ${task.title} [${task.status}]`;
      expect(consoleOutput.some(line => line === outputLine)).toBeFalse();
    });
  });
  
  it("shows all tasks including DONE when --all flag is used", async () => {
    const command = createListCommand();
    
    // Execute the command action with the --all flag
    await command.action({ all: true });
    
    // Verify mockListTasks was called
    expect(mockListTasks).toHaveBeenCalled();
    
    // Verify ALL tasks were included in the output
    expect(consoleOutput.length).toBeGreaterThan(1);
    expect(consoleOutput[0]).toEqual("Tasks:");
    
    sampleTasks.forEach((task) => {
      const outputLine = `- ${task.id}: ${task.title} [${task.status}]`;
      expect(consoleOutput.some(line => line === outputLine)).toBeTrue();
    });
  });
  
  it("respects status flag when provided", async () => {
    const command = createListCommand();
    
    // Execute the command action with a status filter
    await command.action({ status: TASK_STATUS.IN_PROGRESS });
    
    // Verify mockListTasks was called with status option
    expect(mockListTasks).toHaveBeenCalledWith({ status: TASK_STATUS.IN_PROGRESS });
  });
  
  it("outputs in JSON format when --json flag is used", async () => {
    const command = createListCommand();
    
    // Mock JSON.stringify to verify the correct data is passed
    const originalStringify = JSON.stringify;
    let stringifiedData: any = null;
    JSON.stringify = jest.fn((data) => {
      stringifiedData = data;
      return originalStringify(data);
    });
    
    // Execute the command action with the --json flag
    await command.action({ json: true });
    
    // Restore original JSON.stringify
    JSON.stringify = originalStringify;
    
    // Verify the correct non-DONE tasks were JSON stringified
    expect(stringifiedData).not.toBeNull();
    expect(Array.isArray(stringifiedData)).toBeTrue();
    expect(stringifiedData.length).toBe(3); // Only non-DONE tasks
    expect(stringifiedData.some((task: any) => task.status === TASK_STATUS.DONE)).toBeFalse();
  });
  
  it("outputs all tasks in JSON format when --json and --all flags are used", async () => {
    const command = createListCommand();
    
    // Mock JSON.stringify to verify the correct data is passed
    const originalStringify = JSON.stringify;
    let stringifiedData: any = null;
    JSON.stringify = jest.fn((data) => {
      stringifiedData = data;
      return originalStringify(data);
    });
    
    // Execute the command action with both --json and --all flags
    await command.action({ json: true, all: true });
    
    // Restore original JSON.stringify
    JSON.stringify = originalStringify;
    
    // Verify ALL tasks were JSON stringified
    expect(stringifiedData).not.toBeNull();
    expect(Array.isArray(stringifiedData)).toBeTrue();
    expect(stringifiedData.length).toBe(5); // All tasks
    expect(stringifiedData.some((task: any) => task.status === TASK_STATUS.DONE)).toBeTrue();
  });
}); 
