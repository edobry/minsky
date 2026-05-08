/**
 * Tests for agent harness detection and installed client detection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  detectAgentHarness,
  hasNativeSubagentSupport,
  detectInstalledClients,
} from "./harness-detection";

const CLAUDE_AND_CURSOR_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CURSOR_SESSION_ID",
  "CURSOR_TRACE_ID",
  "VSCODE_PID",
];

function withCleanEnv(envVars: string[]) {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const v of envVars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of envVars) {
      if (savedEnv[v] === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = savedEnv[v];
      }
    }
  });
}

describe("detectAgentHarness", () => {
  withCleanEnv(CLAUDE_AND_CURSOR_ENV_VARS);

  // CLAUDECODE=1 (no underscore) is the canonical Claude Code 2.1.x env var.
  test("returns 'claude-code' when CLAUDECODE is set", () => {
    process.env.CLAUDECODE = "1";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_ENTRYPOINT is set", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_SESSION_ID is set", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "abc-123";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_PROJECT_DIR is set", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when legacy CLAUDE_CODE is set", () => {
    process.env.CLAUDE_CODE = "1";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'cursor' when CURSOR_SESSION_ID is set", () => {
    process.env.CURSOR_SESSION_ID = "abc123";
    expect(detectAgentHarness()).toBe("cursor");
  });

  test("returns 'cursor' when VSCODE_PID is set", () => {
    process.env.VSCODE_PID = "1234";
    expect(detectAgentHarness()).toBe("cursor");
  });

  test("returns 'standalone' when no relevant env vars are set", () => {
    expect(detectAgentHarness()).toBe("standalone");
  });
});

describe("hasNativeSubagentSupport", () => {
  withCleanEnv(CLAUDE_AND_CURSOR_ENV_VARS);

  test("returns true when running in claude-code (CLAUDECODE)", () => {
    process.env.CLAUDECODE = "1";
    expect(hasNativeSubagentSupport()).toBe(true);
  });

  test("returns false in standalone mode", () => {
    expect(hasNativeSubagentSupport()).toBe(false);
  });
});

describe("detectInstalledClients", () => {
  test("returns an array", () => {
    const clients = detectInstalledClients();
    expect(Array.isArray(clients)).toBe(true);
  });

  test("returns stable results on repeated calls", () => {
    // detectInstalledClients probes the real filesystem; verify it is deterministic.
    // Both outcomes (cursor present or absent) are valid depending on the machine.
    const clients1 = detectInstalledClients();
    const clients2 = detectInstalledClients();
    expect(clients1).toEqual(clients2);
  });

  test("returned values are all ManagedClient members", () => {
    const validClients = new Set([
      "cursor",
      "claude-desktop",
      "vscode",
      "windsurf",
      "junie",
      "codex",
      "openhands",
    ]);
    const clients = detectInstalledClients();
    for (const c of clients) {
      expect(validClients.has(c)).toBe(true);
    }
  });
});
