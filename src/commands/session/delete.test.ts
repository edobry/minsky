import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join, resolve, dirname } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import type { SessionRecord } from "../../domain/session.ts";
import { 
  createUniqueTestDir, 
  cleanupTestDir, 
  setupMinskyTestEnv, 
  createTestEnv, 
  standardSpawnOptions 
} from "../../utils/test-helpers.ts";
import type { MinskyTestEnv } from "../../utils/test-helpers.ts";

// Path to the CLI entry point
const CLI = resolve(process.cwd(), "src/cli.ts");

// Create a unique test directory for this test file
const TEST_DIR = createUniqueTestDir("minsky-session-delete-test");
let testEnv: MinskyTestEnv;
let minskyDir: string;
let gitDir: string;
let sessionDbPath: string;

// Type for a test session record with branch and taskId properties
interface TestSessionRecord {
  session: string;
  repoUrl: string;
  repoName: string;
  createdAt: string;
  branch?: string;
  taskId?: string;
}

function setupSessionDb(sessions: SessionRecord[]) {
  try {
    // Setup the Minsky test environment
    testEnv = setupMinskyTestEnv(TEST_DIR);
    minskyDir = testEnv.minskyDir;
    gitDir = testEnv.gitDir;
    sessionDbPath = testEnv.sessionDbPath;
    
    // Ensure parent directories exist
    const sessionDbDir = dirname(sessionDbPath);
    if (!existsSync(sessionDbDir)) {
      mkdirSync(sessionDbDir, { recursive: true });
    }
    
    // Write the session database with error handling
    try {
      writeFileSync(sessionDbPath, JSON.stringify(sessions, null, 2), { encoding: "utf8" });
      
      // Verify the file was written successfully
      if (!existsSync(sessionDbPath)) {
        throw new Error(`Failed to create session DB at ${sessionDbPath}`);
      }
      
      // Read it back to verify it's valid
      const content = readFileSync(sessionDbPath, "utf8");
      JSON.parse(content); // Verify valid JSON
    } catch (error) {
      console.error(`Error writing session DB: ${error}`);
      throw error;
    }
    
    // Create dummy session repo dirs for deletion tests
    for (const session of sessions) {
      if (session.repoName && session.session) {
        const repoDir = join(gitDir, session.repoName);
        const sessionDir = join(repoDir, session.session);
        
        // Create repo directory
        mkdirSync(repoDir, { recursive: true });
        
        // Create session directory
        mkdirSync(sessionDir, { recursive: true });
        
        // Verify directory creation
        if (!existsSync(sessionDir)) {
          throw new Error(`Failed to create session directory at ${sessionDir}`);
        }
      }
    }
    
    console.log(`Test setup: Created session DB at ${sessionDbPath} with ${sessions.length} sessions`);
    console.log(`XDG_STATE_HOME will be set to: ${TEST_DIR}`);
    console.log(`SessionDB file exists: ${existsSync(sessionDbPath)}`);
    console.log(`SessionDB content: ${readFileSync(sessionDbPath, "utf8")}`);
  } catch (error) {
    console.error(`Error in setupSessionDb: ${error}`);
    throw error;
  }
}

// Helper to run CLI command 
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

describe("minsky session delete CLI", () => {
  beforeEach(() => {
    // Setup is handled by setupSessionDb in each test
    cleanupTestDir(TEST_DIR);
  });

  afterEach(() => {
    cleanupTestDir(TEST_DIR);
  });

  test("deletes session when it exists", () => {
    const initialSessions: TestSessionRecord[] = [
      // Need repoName for getSessionRepoPath used by the command
      { session: "foo", repoUrl: "r1", createdAt: "c1", repoName: "repo/foo" }, 
      { session: "bar", repoUrl: "r2", createdAt: "c2", repoName: "repo/bar" },
    ];
    setupSessionDb(initialSessions);

    // Add --force to bypass interactive prompt
    const { stdout, stderr, status } = runCliCommand(["session", "delete", "foo", "--force"]);

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Session \"foo\" successfully deleted");
  });

  test("outputs JSON format with --json flag", () => {
    const initialSessions: TestSessionRecord[] = [
      { session: "foo", repoUrl: "r1", createdAt: "c1", repoName: "repo/foo" }, 
      { session: "bar", repoUrl: "r2", createdAt: "c2", repoName: "repo/bar" },
    ];
    setupSessionDb(initialSessions);

    // Add --force and --json flags
    const { stdout, stderr, status } = runCliCommand(["session", "delete", "foo", "--force", "--json"]);

    expect(status).toBe(0);
    expect(stderr).toBe("");
    
    // Parse the JSON output
    const jsonOutput = JSON.parse(stdout);
    expect(jsonOutput.success).toBe(true);
    expect(jsonOutput.session).toBe("foo");
  });

  test("handles non-existent sessions with appropriate error", () => {
    const initialSessions: TestSessionRecord[] = [
      { session: "foo", repoUrl: "r1", createdAt: "c1", repoName: "repo/foo" }
    ];
    setupSessionDb(initialSessions);

    const { stdout, stderr, status } = runCliCommand(["session", "delete", "nonexistent", "--force"]);

    expect(status !== 0).toBe(true);
    expect(stderr).toContain("Session \"nonexistent\" not found.");
    expect(stdout).toBe("");
  });

  test("handles non-existent sessions with JSON output", () => {
    setupSessionDb([]);

    const { stdout, stderr, status } = runCliCommand(["session", "delete", "nonexistent", "--force", "--json"]);

    expect(status !== 0).toBe(true);
    expect(stderr).toBe("");
    
    // Parse the JSON output
    const jsonOutput = JSON.parse(stdout);
    expect(jsonOutput.success).toBe(false);
    expect(jsonOutput.error).toContain("not found");
  });
}); 
