import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const CLI = "src/cli.ts";
const SESSION_DB_PATH = join(process.env.XDG_STATE_HOME || "/tmp", "minsky", "session-db.json");

function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; branch: string; createdAt: string; taskId?: string }>) {
  mkdirSync(join(process.env.XDG_STATE_HOME || "/tmp", "minsky"), { recursive: true });
  writeFileSync(SESSION_DB_PATH, JSON.stringify(sessions, null, 2));
}

// Mock the getCurrentSession function for testing
// We can't easily mock in integration tests, so we'll use environment variables instead
const ENV_VARS = {
  MINSKY_TEST_CURRENT_SESSION: "auto-detected-session"
};

describe("session command workspace auto-detection", () => {
  beforeEach(() => {
    setupSessionDb([
      { 
        session: "auto-detected-session", 
        repoUrl: "file:///test/repo", 
        branch: "feature", 
        createdAt: "2024-01-01", 
        taskId: "T123" 
      },
      { 
        session: "manual-session", 
        repoUrl: "file:///other/repo", 
        branch: "other", 
        createdAt: "2024-01-02", 
        taskId: "T456" 
      }
    ]);
  });

  afterEach(() => {
    rmSync(SESSION_DB_PATH, { force: true });
  });

  // We'll mock the getCurrentSession function by setting/unsetting the environment variable
  // and modifying the implementation in the test commands

  describe("session dir command", () => {
    it("auto-detects session when no arguments are provided", () => {
      // Create a special version of the CLI file for this test that uses the environment variable
      const testCliContent = `#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./commands/session";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./domain/workspace";
import * as workspaceModule from "./domain/workspace";

// Mock getCurrentSession to return the test environment variable
workspaceModule.getCurrentSession = async () => {
  return process.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program
  .name("minsky")
  .description("CLI for managing Minsky workflow")
  .version("0.1.0");

program.addCommand(createSessionCommand());

program.parse();`;

      const testCliPath = join(process.cwd(), "test-cli.ts");
      try {
        writeFileSync(testCliPath, testCliContent);
        
        // Run the command with the environment variable set
        const { stdout, stderr, status } = spawnSync("bun", ["run", testCliPath, "session", "dir"], { 
          encoding: "utf-8", 
          env: { ...process.env, XDG_STATE_HOME: "/tmp", ...ENV_VARS } 
        });
        
        expect(status).toBe(0);
        expect(stderr).toBe("");
        // The exact path will depend on the session database implementation
        // Just check that it includes the session name which confirms auto-detection worked
        expect(stdout).toContain("auto-detected-session");
      } finally {
        // Clean up
        rmSync(testCliPath, { force: true });
      }
    });

    it("uses explicit session name when provided", () => {
      // Create a special version of the CLI file for this test
      const testCliContent = `#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./commands/session";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./domain/workspace";
import * as workspaceModule from "./domain/workspace";

// Mock getCurrentSession to return the test environment variable
workspaceModule.getCurrentSession = async () => {
  return process.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program
  .name("minsky")
  .description("CLI for managing Minsky workflow")
  .version("0.1.0");

program.addCommand(createSessionCommand());

program.parse();`;

      const testCliPath = join(process.cwd(), "test-cli.ts");
      try {
        writeFileSync(testCliPath, testCliContent);
        
        // Run the command with explicit session name
        const { stdout, stderr, status } = spawnSync("bun", ["run", testCliPath, "session", "dir", "manual-session"], { 
          encoding: "utf-8", 
          env: { ...process.env, XDG_STATE_HOME: "/tmp", ...ENV_VARS } 
        });
        
        expect(status).toBe(0);
        expect(stderr).toBe("");
        // Should use manual-session, not the auto-detected one
        expect(stdout).toContain("manual-session");
      } finally {
        // Clean up
        rmSync(testCliPath, { force: true });
      }
    });

    it("respects --ignore-workspace flag", () => {
      // Create a special version of the CLI file for this test
      const testCliContent = `#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./commands/session";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./domain/workspace";
import * as workspaceModule from "./domain/workspace";

// Mock getCurrentSession to return the test environment variable
workspaceModule.getCurrentSession = async () => {
  return process.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program
  .name("minsky")
  .description("CLI for managing Minsky workflow")
  .version("0.1.0");

program.addCommand(createSessionCommand());

program.parse();`;

      const testCliPath = join(process.cwd(), "test-cli.ts");
      try {
        writeFileSync(testCliPath, testCliContent);
        
        // Run the command with --ignore-workspace flag
        const { stdout, stderr, status } = spawnSync("bun", ["run", testCliPath, "session", "dir", "--ignore-workspace"], { 
          encoding: "utf-8", 
          env: { ...process.env, XDG_STATE_HOME: "/tmp", ...ENV_VARS } 
        });
        
        // Should fail because no session is provided and auto-detection is disabled
        expect(status).not.toBe(0);
        expect(stderr).toContain("You must provide either a session name or --task");
      } finally {
        // Clean up
        rmSync(testCliPath, { force: true });
      }
    });
  });

  describe("session get command", () => {
    it("auto-detects session when no arguments are provided", () => {
      // Create a special version of the CLI file for this test
      const testCliContent = `#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./commands/session";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./domain/workspace";
import * as workspaceModule from "./domain/workspace";

// Mock getCurrentSession to return the test environment variable
workspaceModule.getCurrentSession = async () => {
  return process.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program
  .name("minsky")
  .description("CLI for managing Minsky workflow")
  .version("0.1.0");

program.addCommand(createSessionCommand());

program.parse();`;

      const testCliPath = join(process.cwd(), "test-cli.ts");
      try {
        writeFileSync(testCliPath, testCliContent);
        
        // Run the command with the environment variable set
        const { stdout, stderr, status } = spawnSync("bun", ["run", testCliPath, "session", "get"], { 
          encoding: "utf-8", 
          env: { ...process.env, XDG_STATE_HOME: "/tmp", ...ENV_VARS } 
        });
        
        expect(status).toBe(0);
        expect(stderr).toBe("");
        // Check for the auto-detected session details
        expect(stdout).toContain("Session: auto-detected-session");
        expect(stdout).toContain("Task ID: T123");
      } finally {
        // Clean up
        rmSync(testCliPath, { force: true });
      }
    });

    it("uses explicit session name when provided", () => {
      // Create a special version of the CLI file for this test
      const testCliContent = `#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./commands/session";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./domain/workspace";
import * as workspaceModule from "./domain/workspace";

// Mock getCurrentSession to return the test environment variable
workspaceModule.getCurrentSession = async () => {
  return process.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program
  .name("minsky")
  .description("CLI for managing Minsky workflow")
  .version("0.1.0");

program.addCommand(createSessionCommand());

program.parse();`;

      const testCliPath = join(process.cwd(), "test-cli.ts");
      try {
        writeFileSync(testCliPath, testCliContent);
        
        // Run the command with explicit session name
        const { stdout, stderr, status } = spawnSync("bun", ["run", testCliPath, "session", "get", "manual-session"], { 
          encoding: "utf-8", 
          env: { ...process.env, XDG_STATE_HOME: "/tmp", ...ENV_VARS } 
        });
        
        expect(status).toBe(0);
        expect(stderr).toBe("");
        // Check for the manual session details, not the auto-detected one
        expect(stdout).toContain("Session: manual-session");
        expect(stdout).toContain("Task ID: T456");
      } finally {
        // Clean up
        rmSync(testCliPath, { force: true });
      }
    });

    it("respects --ignore-workspace flag", () => {
      // Create a special version of the CLI file for this test
      const testCliContent = `#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./commands/session";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./domain/workspace";
import * as workspaceModule from "./domain/workspace";

// Mock getCurrentSession to return the test environment variable
workspaceModule.getCurrentSession = async () => {
  return process.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program
  .name("minsky")
  .description("CLI for managing Minsky workflow")
  .version("0.1.0");

program.addCommand(createSessionCommand());

program.parse();`;

      const testCliPath = join(process.cwd(), "test-cli.ts");
      try {
        writeFileSync(testCliPath, testCliContent);
        
        // Run the command with --ignore-workspace flag
        const { stdout, stderr, status } = spawnSync("bun", ["run", testCliPath, "session", "get", "--ignore-workspace"], { 
          encoding: "utf-8", 
          env: { ...process.env, XDG_STATE_HOME: "/tmp", ...ENV_VARS } 
        });
        
        // Should fail because no session is provided and auto-detection is disabled
        expect(status).not.toBe(0);
        expect(stderr).toContain("You must provide either a session name or --task");
      } finally {
        // Clean up
        rmSync(testCliPath, { force: true });
      }
    });

    it("outputs JSON format with auto-detection", () => {
      // Create a special version of the CLI file for this test
      const testCliContent = `#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./commands/session";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./domain/workspace";
import * as workspaceModule from "./domain/workspace";

// Mock getCurrentSession to return the test environment variable
workspaceModule.getCurrentSession = async () => {
  return process.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program
  .name("minsky")
  .description("CLI for managing Minsky workflow")
  .version("0.1.0");

program.addCommand(createSessionCommand());

program.parse();`;

      const testCliPath = join(process.cwd(), "test-cli.ts");
      try {
        writeFileSync(testCliPath, testCliContent);
        
        // Run the command with the environment variable set
        const { stdout, stderr, status } = spawnSync("bun", ["run", testCliPath, "session", "get", "--json"], { 
          encoding: "utf-8", 
          env: { ...process.env, XDG_STATE_HOME: "/tmp", ...ENV_VARS } 
        });
        
        expect(status).toBe(0);
        expect(stderr).toBe("");
        
        // Parse and check the JSON output
        const result = JSON.parse(stdout);
        expect(result.session).toBe("auto-detected-session");
        expect(result.taskId).toBe("T123");
      } finally {
        // Clean up
        rmSync(testCliPath, { force: true });
      }
    });
  });
}); 
