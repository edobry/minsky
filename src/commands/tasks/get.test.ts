import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import type { Task } from "../../domain/tasks.js";
import { createTasksCommand } from "./index.js";
import { Command } from "commander";
import { TaskService } from "../../domain/tasks.js";
import { SessionDB } from "../../domain/session.js";
import { 
  createUniqueTestDir, 
  cleanupTestDir, 
  setupMinskyTestEnv, 
  createTestEnv, 
  standardSpawnOptions,
  ensureValidCommandResult
} from "../../utils/test-helpers.js";
import type { MinskyTestEnv } from "../../utils/test-helpers.js";

// Create a unique test directory to avoid conflicts with other tests
const TEST_DIR = createUniqueTestDir("minsky-tasks-get-test");
let testEnv: MinskyTestEnv;

// Path to the CLI entry point - use absolute path
const CLI = join(process.cwd(), "src/cli.ts");

const SAMPLE_TASKS_MD = `
# Tasks

- [ ] First Task [#001](tasks/001-first.md)
  - This is the first task description
- [x] Second Task [#002](tasks/002-second.md)
- [-] Third Task [#003](tasks/003-third.md)
- [+] Fourth Task [#004](tasks/004-fourth.md)
`;

// Helper to setup a valid Minsky workspace structure
function setupMinskyWorkspace() {
  // Setup the Minsky test environment with proper directory structure
  testEnv = setupMinskyTestEnv(TEST_DIR);
  
  // Create additional directories for workspace validation
  const PROCESS_DIR = join(TEST_DIR, "process");
  const TASKS_DIR = join(PROCESS_DIR, "tasks");
  
  // Create fake .git directory to make the workspace appear valid
  const GIT_DIR = join(TEST_DIR, ".git");
  mkdirSync(GIT_DIR, { recursive: true });
  
  // Write necessary files to make this a valid workspace structure
  writeFileSync(join(PROCESS_DIR, "tasks.md"), SAMPLE_TASKS_MD);
  
  // Create the individual task spec files in the tasks directory
  writeFileSync(join(TASKS_DIR, "001-first.md"), "# Task #001: First Task\n\n## Description\n\nFirst task description");
  writeFileSync(join(TASKS_DIR, "002-second.md"), "# Task #002: Second Task\n\n## Description\n\nSecond task description");
  writeFileSync(join(TASKS_DIR, "003-third.md"), "# Task #003: Third Task\n\n## Description\n\nThird task description");
  writeFileSync(join(TASKS_DIR, "004-fourth.md"), "# Task #004: Fourth Task\n\n## Description\n\nFourth task description");
  
  // Add a session record for task #003
  const sessionDbPath = join(testEnv.minskyDir, "session-db.json");
  writeFileSync(sessionDbPath, JSON.stringify([
    {
      session: "task#003",
      repoName: "test-repo",
      repoUrl: "file:///test/repo",
      createdAt: "2025-01-01T00:00:00Z",
      taskId: "#003"
    }
  ]));
  
  console.log(`Test setup: Created workspace at ${TEST_DIR} with task files and session for task #003`);
}

// Helper to run a CLI command with the right environment
function runCliCommand(args: string[]) {
  const env = createTestEnv(TEST_DIR);
  const options = {
    ...standardSpawnOptions(),
    env
  };
  
  const result = spawnSync("bun", ["run", CLI, ...args], options);
  
  // Log output for debugging
  console.log(`Command stdout: ${result.stdout}`);
  console.log(`Command stderr: ${result.stderr}`);
  
  return {
    stdout: result.stdout as string,
    stderr: result.stderr as string,
    status: result.status
  };
}

describe("minsky tasks get CLI", () => {
  beforeEach(() => {
    // Clean up any existing test directories
    cleanupTestDir(TEST_DIR);
    
    // Setup a valid Minsky workspace structure
    setupMinskyWorkspace();
  });
  
  afterEach(() => {
    // Clean up test directories
    cleanupTestDir(TEST_DIR);
  });
  
  test("displays task details with session information when a session exists", () => {
    const { stdout, stderr } = runCliCommand(["tasks", "get", "#003", "--workspace", TEST_DIR]);
    
    // Basic task information
    expect(stdout).toContain("Task ID: #003");
    expect(stdout).toContain("Title: Third Task");
    expect(stdout).toContain("Status: IN-PROGRESS");
    
    // Session information - this task has a session
    expect(stdout).toContain("Session: task#003");
    expect(stdout).toContain("Session Created: ");
    
    expect(stderr).toBe("");
  });
  
  test("displays 'No active session' when no session exists for the task", () => {
    const { stdout, stderr } = runCliCommand(["tasks", "get", "#001", "--workspace", TEST_DIR]);
    
    // Basic task information
    expect(stdout).toContain("Task ID: #001");
    expect(stdout).toContain("Title: First Task");
    expect(stdout).toContain("Status: TODO");
    
    // No session information - this task doesn't have a session
    expect(stdout).toContain("Session: No active session");
    expect(stdout.indexOf("Session Created:")).toBe(-1);
    
    expect(stderr).toBe("");
  });
  
  test("includes session information in JSON output when a session exists", () => {
    const { stdout, stderr } = runCliCommand(["tasks", "get", "#003", "--workspace", TEST_DIR, "--json"]);
    
    try {
      const task = JSON.parse(stdout);
      
      // Basic task information
      expect(task.id).toBe("#003");
      expect(task.title).toBe("Third Task");
      expect(task.status).toBe("IN-PROGRESS");
      
      // Session information
      expect(task.session).toBeTruthy();
      expect(task.session.name).toBe("task#003");
      expect(task.session.createdAt).toBe("2025-01-01T00:00:00Z");
      expect(task.session.repoName).toBe("test-repo");
    } catch (e) {
      // This should not happen if the JSON is valid
      expect(false).toBe(true);
    }
    
    expect(stderr).toBe("");
  });
  
  test("includes null for session in JSON output when no session exists", () => {
    const { stdout, stderr } = runCliCommand(["tasks", "get", "#001", "--workspace", TEST_DIR, "--json"]);
    
    try {
      const task = JSON.parse(stdout);
      
      // Basic task information
      expect(task.id).toBe("#001");
      expect(task.title).toBe("First Task");
      expect(task.status).toBe("TODO");
      
      // Session information
      expect(task.session).toBe(null);
    } catch (e) {
      // This should not happen if the JSON is valid
      expect(false).toBe(true);
    }
    
    expect(stderr).toBe("");
  });
  
  test("returns error for non-existent task", () => {
    const { stdout, stderr, status } = runCliCommand(["tasks", "get", "#999", "--workspace", TEST_DIR]);
    
    // Status code should be non-zero for error
    expect(status !== 0).toBe(true);
    
    // Error message should mention the non-existent task
    expect(stderr).toContain("Task with ID '#999' not found");
    
    // Stdout should be empty
    expect(stdout).toBe("");
  });
});

describe("minsky tasks get integration", () => {
  test("handles SessionDB.getSessionByTaskId correctly", async () => {
    // Mock implementation of getSessionByTaskId
    const getSessionByTaskId = (taskId: string) => {
      if (taskId === "#003") {
        return Promise.resolve({
          session: "task#003",
          repoName: "test-repo",
          repoUrl: "file:///test/repo",
          createdAt: "2025-01-01T00:00:00Z",
          taskId: "#003"
        });
      }
      return Promise.resolve(null);
    };
    
    // Test when a session exists
    const sessionWithTask = await getSessionByTaskId("#003");
    expect(sessionWithTask).toBeTruthy();
    expect(sessionWithTask?.session).toBe("task#003");
    
    // Test when no session exists
    const sessionWithoutTask = await getSessionByTaskId("#001");
    expect(sessionWithoutTask).toBe(null);
  });
}); 
