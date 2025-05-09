import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { 
  createUniqueTestDir, 
  cleanupTestDir, 
  setupMinskyTestEnv, 
  createTestEnv, 
  standardSpawnOptions
} from "../../utils/test-helpers.ts";
import type { MinskyTestEnv } from "../../utils/test-helpers.ts";

// Create a unique test directory
const TEST_DIR = createUniqueTestDir("minsky-session-list-test");
let testEnv: MinskyTestEnv;
let sessionDbPath: string;

// Path to the CLI entry point
const CLI = join(process.cwd(), "src/cli.ts");

// Helper to setup session DB with consistent structure
function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; repoName?: string; branch?: string; createdAt: string }>) {
  // Setup the test environment
  testEnv = setupMinskyTestEnv(TEST_DIR);
  sessionDbPath = testEnv.sessionDbPath;
  
  try {
    // Create the minsky directory structure
    const minskyDir = join(TEST_DIR, "minsky");
    if (!existsSync(minskyDir)) {
      mkdirSync(minskyDir, { recursive: true });
    }
    
    // Ensure parent directory of sessionDbPath exists
    const sessionDbDir = dirname(sessionDbPath);
    if (!existsSync(sessionDbDir)) {
      mkdirSync(sessionDbDir, { recursive: true });
    }
    
    // Create sessions with consistent data
    const normalizedSessions = sessions.map(session => ({
      ...session,
      // Ensure repoName is always set for consistency
      repoName: session.repoName || session.repoUrl.replace(/[^\w-]/g, "_"),
      // Ensure branch is defined
      branch: session.branch || ""
    }));
    
    // Write to the database file
    writeFileSync(
      sessionDbPath, 
      JSON.stringify(normalizedSessions, null, 2),
      { encoding: "utf8" }
    );
    
    // Verify the file exists
    if (!existsSync(sessionDbPath)) {
      throw new Error(`Session DB file not created at ${sessionDbPath}`);
    }
    
    // Log for debugging
    console.log(`Test setup: Created session DB at ${sessionDbPath} with ${sessions.length} sessions`);
    console.log(`XDG_STATE_HOME will be set to: ${TEST_DIR}`);
    console.log(`SessionDB file exists: ${existsSync(sessionDbPath)}`);
  } catch (error) {
    console.error(`Error in setupSessionDb: ${error}`);
    throw error;
  }
}

// Helper to run CLI command with proper environment
function runCliCommand(args: string[], additionalEnv: Record<string, string> = {}) {
  const env = createTestEnv(TEST_DIR, additionalEnv);
  const options = {
    ...standardSpawnOptions(),
    env
  };
  
  // Run the command
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

describe("minsky session list CLI", () => {
  beforeEach(() => {
    // Clean up any existing test directories
    cleanupTestDir(TEST_DIR);
  });
  
  afterEach(() => {
    // Clean up test directories
    cleanupTestDir(TEST_DIR);
  });

  test("prints human output when sessions exist", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", repoName: "repo", branch: "main", createdAt: "2024-01-01" },
      { session: "bar", repoUrl: "https://repo2", repoName: "repo2", createdAt: "2024-01-02" }
    ]);
    
    const { stdout, stderr } = runCliCommand(["session", "list"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Session: bar");
  });

  test("prints JSON output with --json", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", repoName: "repo", branch: "main", createdAt: "2024-01-01" }
    ]);
    
    const { stdout, stderr } = runCliCommand(["session", "list", "--json"]);
    expect(stderr).toBe("");
    
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].session).toBe("foo");
  });

  test("prints [] for --json when no sessions", () => {
    setupSessionDb([]);
    
    const { stdout, stderr } = runCliCommand(["session", "list", "--json"]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("[]");
  });

  test("prints human message when no sessions", () => {
    setupSessionDb([]);
    
    const { stdout, stderr } = runCliCommand(["session", "list"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("No sessions found.");
  });
}); 
