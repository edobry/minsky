import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join, resolve } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import type { SessionRecord } from "../../domain/session.js";
import { 
  createUniqueTestDir, 
  cleanupTestDir, 
  setupMinskyTestEnv, 
  createTestEnv, 
  standardSpawnOptions
} from "../../utils/test-helpers.js";
import type { MinskyTestEnv } from "../../utils/test-helpers.js";

// Path to the CLI entry point
const CLI = resolve(process.cwd(), "src/cli.ts");

// Create a unique test directory for this test file
const TEST_DIR = createUniqueTestDir("minsky-session-delete-test");
let testEnv: MinskyTestEnv;
let minskyDir: string;
let sessionDbPath: string;

function setupSessionDb(sessions: SessionRecord[]) {
  // Setup the Minsky test environment
  testEnv = setupMinskyTestEnv(TEST_DIR);
  minskyDir = testEnv.minskyDir;
  sessionDbPath = testEnv.sessionDbPath;
  
  // Write the session database
  writeFileSync(sessionDbPath, JSON.stringify(sessions, null, 2));
  
  // Create dummy session repo dirs for deletion tests
  for (const session of sessions) {
    if (session.repoName && session.session) {
      const sessionRepoDir = join(minskyDir, "git", session.repoName, "sessions", session.session);
      mkdirSync(sessionRepoDir, { recursive: true });
    }
  }
}

// Helper to run a CLI command with the right environment
function runCliCommand(args: string[]) {
  const env = createTestEnv(TEST_DIR);
  const options = {
    ...standardSpawnOptions(),
    env
  };
  
  const result = spawnSync("bun", ["run", CLI, ...args], options);
  
  // We don't use ensureValidCommandResult here because we have tests for error cases
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
    const initialSessions: SessionRecord[] = [
      // Need repoName for getSessionRepoPath used by the command
      { session: "foo", repoUrl: "r1", createdAt: "c1", repoName: "repo/foo" }, 
      { session: "bar", repoUrl: "r2", createdAt: "c2", repoName: "repo/bar" },
    ];
    setupSessionDb(initialSessions);

    // Add --force to bypass interactive prompt
    const { stdout, stderr, status } = runCliCommand(["session", "delete", "foo", "--force"]);

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("Session \"foo\" successfully deleted.");

    // Verify session is removed from DB
    const dbContents = JSON.parse(readFileSync(sessionDbPath, "utf-8"));
    expect(dbContents.length).toBe(1);
    expect(dbContents[0].session).toBe("bar");
  });

  test("outputs JSON format with --json flag", () => {
    const initialSessions: SessionRecord[] = [
      { session: "foo", repoUrl: "r1", createdAt: "c1", repoName: "repo/foo" },
    ];
    setupSessionDb(initialSessions);

    // Add --force to bypass interactive prompt
    const { stdout, stderr, status } = runCliCommand(["session", "delete", "foo", "--force", "--json"]);
    
    expect(stderr).toBe("");
    expect(status).toBe(0);
    
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.session).toBe("foo");
    expect(result.message).toContain("successfully deleted");

    // Verify session is removed from DB
    const dbContents = JSON.parse(readFileSync(sessionDbPath, "utf-8"));
    expect(dbContents.length).toBe(0);
  });

  test("handles non-existent sessions with appropriate error", () => {
    setupSessionDb([{ session: "bar", repoUrl: "r2", createdAt: "c2", repoName: "repo/bar" }]);
    const { stdout, stderr, status } = runCliCommand(["session", "delete", "nonexistent"]);

    expect(status !== 0).toBe(true);
    // Match actual CLI output which uses double quotes for session name
    expect(stderr).toContain("Session \"nonexistent\" not found.");
    expect(stdout).toBe("");
  });

  test("handles non-existent sessions with JSON output", () => {
    setupSessionDb([{ session: "bar", repoUrl: "r2", createdAt: "c2", repoName: "repo/bar" }]);
    // When session not found, CLI exits 1. JSON output reflects this.
    const { stdout, stderr, status } = runCliCommand(["session", "delete", "nonexistent", "--json"]);
    
    expect(stderr).toBe(""); // Error message is in JSON stdout, not stderr
    expect(status).toBe(1); // CLI should exit 1 if session not found, even with --json

    const result = JSON.parse(stdout);
    expect(result.success).toBe(false);
    expect(result.session).toBe("nonexistent");
    expect(result.error).toContain("Session \"nonexistent\" not found."); // Error message in JSON uses double quotes
  });
}); 
